// One round of Keel's loop for one vault:
// observe -> forecast -> check -> decide -> act -> learn.

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  addDays,
  vaultBills,
  topUps,
  idleMove,
  recallNeed,
  approvalsFor,
  checkCounterparty,
  decide,
  draftRule,
  firstShortfall,
  forecast,
  isCrossChain,
  isSpike,
  type Bill,
  type Proposal,
  type RuleDraft,
} from "./brain";
import type { Chain, Config } from "./chain";
import { explain } from "./explain";
import { deadlineFromNow, findToken, quote, status as swapStatus, FINAL, tokens as intentsTokens } from "./intents";
import { balances, broadcast, chainInfo, client, knownChain, prepareTransfer, receipt, routeFor, toTokenUnits, usdc, vaultAddress, vaultRoute } from "./evm";

const STATE_FILE = resolve(import.meta.dirname, "../state.json");
const LEDGER_FILE = resolve(import.meta.dirname, "../ledger.jsonl");
const BILLS_FILE = resolve(import.meta.dirname, "../../config/bills.json");

export interface State {
  handled: Record<
    string,
    Record<
      string,
      { action: string; tx?: string; proposalId?: number; depositAddress?: string; swap?: string; route?: string; evmTx?: string; chainId?: number; at: string }
    >
  >;
  codeHashes: Record<string, string>;
  drafts: Record<string, RuleDraft[]>;
}

export function loadState(): State {
  if (!existsSync(STATE_FILE)) return { handled: {}, codeHashes: {}, drafts: {} };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"), (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
}

export function saveState(s: State) {
  writeFileSync(STATE_FILE, JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), 2));
}

interface RawBill {
  id: string;
  payee: string;
  amount: string; // in whole tokens, for example "132.00"
  due: string; // YYYY-MM-DD, or "+N" for N days from today
  memo?: string;
  chain?: string;
  token?: string;
}

/**
 * Reads the vault's bills. A bill with a bad amount, date, id or payee is
 * skipped and reported through `bad`, so one typo never stops the others.
 */
export function loadBills(vaultId: string, decimals: number, today: string, bad: (msg: string) => void = () => {}): Bill[] {
  if (!existsSync(BILLS_FILE)) return [];
  let all: Record<string, RawBill[]>;
  try {
    all = JSON.parse(readFileSync(BILLS_FILE, "utf8"));
  } catch (e) {
    bad(`config/bills.json is not valid JSON (${String(e).slice(0, 80)}); no bills read`);
    return [];
  }
  const out: Bill[] = [];
  const seen = new Set<string>();
  for (const b of Array.isArray(all[vaultId]) ? all[vaultId] : []) {
    try {
      if (typeof b?.id !== "string" || !/^[\w.:-]{1,64}$/.test(b.id)) throw new Error("id must be 1 to 64 letters, digits or - _ . :");
      if (seen.has(b.id)) throw new Error("duplicate id");
      if (typeof b.payee !== "string" || !b.payee) throw new Error("payee is missing");
      if (typeof b.due !== "string") throw new Error("due is missing");
      if (b.token !== undefined && (typeof b.token !== "string" || !/^[A-Za-z0-9.]{1,12}$/.test(b.token))) throw new Error("token must be a symbol like USDT");
      if (b.token !== undefined && !b.chain) throw new Error("token needs a chain");
      const amount = toUnits(String(b.amount), decimals);
      if (amount <= 0n) throw new Error("amount must be above zero");
      const due = /^\+\d{1,4}$/.test(b.due) ? addDays(today, Number(b.due.slice(1))) : b.due;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(`${due}T00:00:00Z`))) throw new Error(`due "${b.due}" is not YYYY-MM-DD or +N`);
      seen.add(b.id);
      out.push({ ...b, amount, due });
    } catch (e) {
      bad(`skipped bill ${JSON.stringify(b?.id ?? "?")}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out;
}

/** "1,234.50" to smallest units. Rejects signs, exponents and anything else. */
export function toUnits(text: string, decimals: number): bigint {
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(text)) throw new Error(`"${text}" is not an amount like 1,234.50`);
  const [w, f = ""] = text.replace(/,/g, "").split(".");
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0").slice(0, decimals) || "0");
}

export function fmt(units: bigint, decimals: number, symbol = ""): string {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const s = `${(v / base).toLocaleString("en-US")}.${(((v % base) * 100n) / base).toString().padStart(2, "0")}`;
  return `${neg ? "-" : ""}${s}${symbol ? ` ${symbol}` : ""}`;
}

export type Event = { vault: string; step: string; text: string; tx?: string };

export interface RoundOptions {
  dryRun: boolean;
  today: string;
  lookaheadDays: number;
  say: (e: Event) => void;
}

export async function runVault(cfg: Config, chain: Chain, vaultId: string, state: State, o: RoundOptions) {
  const say = (step: string, text: string, tx?: string) => {
    const e = { vault: vaultId, step, text, tx };
    o.say(e);
    appendFileSync(LEDGER_FILE, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n");
  };

  // Observe
  const policy = await chain.policy(vaultId);
  if (!("agent_key" in policy) || policy.agent_key !== (await chain.agentPublicKey())) {
    say("observe", "skipped: this vault does not hold Keel's current agent key");
    return;
  }
  const meta = await chain.view<{ symbol: string; decimals: number }>(policy.token_id, "ft_metadata");
  const [cash, proposals] = await Promise.all([chain.balance(policy.token_id, vaultId), chain.proposals(vaultId)]);
  let balance = cash;
  const money = (u: bigint) => fmt(u, meta.decimals, meta.symbol);
  // Bills the owner listed on the vault, then any from config/bills.json (older demo vaults).
  // Top-ups for the owner's card and own wallets that run below their target.
  const allPayees = (await chain.payees(vaultId)).filter((p) => !policy.blocklist.includes(p.account_id));
  // Savings at a lending market (Burrow) the owner approved.
  const market = allPayees.find((p) => p.kind === "yield" && p.lending);
  const position = market ? await chain.lendingPosition(market.account_id, vaultId, policy.token_id).catch(() => null) : null;
  const payees = allPayees.filter((p) => p.keep_at);
  const held: Record<string, bigint> = {};
  for (const p of payees) held[p.account_id] = await chain.balance(policy.token_id, p.account_id).catch(() => 0n);
  const listed = [...vaultBills(await chain.bills(vaultId), o.today), ...topUps(payees, held, o.today)];
  const ids = new Set(listed.map((b) => b.id));
  const bills = [...listed, ...loadBills(vaultId, meta.decimals, o.today, (msg) => say("observe", msg)).filter((b) => !ids.has(b.id))];
  const handled = (state.handled[vaultId] ??= {});
  const open = bills.filter((b) => !handled[b.id]);
  say("observe", `balance ${money(balance)}, ${proposals.filter((p) => p.status === "pending").length} proposals waiting, ${open.length} open bills`);

  // Forecast
  // Blocklisted payees are never paid, so they do not count against the balance.
  const days = forecast(balance, open.filter((b) => !policy.blocklist.includes(b.payee)), o.today);
  const short = firstShortfall(days);
  say("forecast", short ? `short ${money(-short.balance)} on ${short.date}` : `covered for the next ${days.length} days (ends at ${money(days.at(-1)!.balance)})`);

  // Reconcile cross-chain moves first, so signed transfers go out before new
  // ones take a nonce. Follow each move until it is final, and
  // re-quote any offer that expired before the owner approved it.
  // Signed EVM transfers Keel did not propose (owner withdrawals) are sent too.
  for (const p of proposals) {
    if (p.status === "signed" && p.evm && knownChain(p.evm.chain_id) && !Object.values(handled).some((h) => h.proposalId === p.id)) {
      handled[`evm-${p.id}`] = { action: "bridge", route: "chain-signatures", proposalId: p.id, at: new Date().toISOString() };
    }
  }
  for (const [id, h] of Object.entries(handled)) {
    if (h.action !== "bridge" || (h.swap && FINAL.includes(h.swap as never))) continue;
    const p = proposals.find((x) => x.id === h.proposalId);
    if (!p) continue;
    if (p.status === "pending" && p.valid_until_ms && p.valid_until_ms < Date.now()) {
      delete handled[id];
      say("reconcile", `${id}: offer #${p.id} expired before approval; Keel will propose a fresh one`);
      continue;
    }
    if (p.status === "pending" && p.evm && p.evm.nonce < (await usedNonces(chain, vaultId, p.evm.chain_id))) {
      delete handled[id];
      say("reconcile", `${id}: #${p.id} can no longer land because another transfer used its nonce; reject it, Keel will propose a fresh one`);
      continue;
    }
    try {
      if (h.route === "chain-signatures") {
        if (p.status === "failed") {
          h.swap = "FAILED";
          say("reconcile", `${id}: NEAR's MPC network did not sign #${p.id}`);
        } else if (p.status === "signed" && p.evm_signed && p.evm) {
          const { raw_tx, tx_hash } = p.evm_signed;
          if (!h.evmTx) {
            // Already on chain (for example after a restart): just record it.
            const landed = await receipt(p.evm.chain_id, tx_hash as `0x${string}`);
            if (landed) {
              if (!o.dryRun) Object.assign(h, { evmTx: tx_hash, chainId: p.evm.chain_id, swap: landed });
              say("reconcile", `${id}: #${p.id} already ${landed === "SUCCESS" ? "paid" : "reverted"} on ${chainInfo(p.evm.chain_id).name}`);
              continue;
            }
          }
          if (!h.evmTx && o.dryRun) {
            say("reconcile", `${id}: #${p.id} is signed; would broadcast it (dry run)`);
            continue;
          }
          if (!h.evmTx) {
            if ((await broadcast(p.evm.chain_id, raw_tx as `0x${string}`, tx_hash as `0x${string}`)) === "stale") {
              delete handled[id];
              say("reconcile", `${id}: #${p.id} was signed with a nonce another transfer already used, so it never arrived. The vault still counts the bill as paid; once you confirm, call release_bill("${p.bill_ref ?? id}") and Keel will propose it again`);
              continue;
            }
            h.evmTx = tx_hash;
            h.chainId = p.evm.chain_id;
            say("reconcile", `${id}: broadcast the vault-signed transfer on ${chainInfo(p.evm.chain_id).name}: ${chainInfo(p.evm.chain_id).explorer}/tx/${tx_hash}`);
          }
          const r = await receipt(p.evm.chain_id, tx_hash as `0x${string}`);
          if (r) {
            h.swap = r;
            say("reconcile", `${id}: ${r === "SUCCESS" ? "paid" : "the transfer reverted"} on ${chainInfo(p.evm.chain_id).name}`);
          }
        }
      } else if (h.depositAddress && p.status === "executed") {
        h.swap = await swapStatus(h.depositAddress);
        say("reconcile", `${id}: NEAR Intents status ${h.swap}`);
      }
    } catch (e) {
      const msg = (e as { shortMessage?: string }).shortMessage ?? String(e);
      say("reconcile", `${id}: could not follow the cross-chain move yet (${msg.slice(0, 140)}); will retry`);
    }
  }

  // Decide and act on bills due soon
  const dueBy = new Date(`${o.today}T00:00:00Z`);
  dueBy.setUTCDate(dueBy.getUTCDate() + o.lookaheadDays);
  // Critical bills first, then by due date, so cash goes to what matters most.
  const due = open
    .filter((b) => new Date(`${b.due}T00:00:00Z`) <= dueBy)
    .sort((a, b) => Number(Boolean(b.critical)) - Number(Boolean(a.critical)) || a.due.localeCompare(b.due));
  // Idle cash last: only what is left above the buffer and the next 14 days of bills.
  const horizon = addDays(o.today, 14);
  const upcoming = open.filter((b) => !isCrossChain(b) && b.due <= horizon && !policy.blocklist.includes(b.payee)).reduce((t, b) => t + b.amount, 0n);
  // Bring savings home first if the bills due soon would break the buffer.
  const buffer = BigInt(policy.min_balance ?? "0");
  let recalled = false;
  if (market && position) {
    if (position.units > 0n) say("observe", `earning: ${money(position.units)} in ${market.name} at ${(position.apr * 100).toFixed(1)}% APR`);
    const dueSoon = due.filter((b) => !isCrossChain(b) && !policy.blocklist.includes(b.payee)).reduce((t, b) => t + b.amount, 0n);
    const need = recallNeed(balance, buffer, dueSoon, position.units);
    if (need > 0n) {
      recalled = true;
      if (o.dryRun) {
        say("decide", `bring ${money(need)} home from ${market.name} (dry run, nothing signed): bills due soon would break the cash buffer`);
      } else {
        try {
          const r = await chain.callAsAgent(vaultId, "recall_from_yield", { market: market.account_id, max_amount: (need * 10n ** BigInt(position.extra)).toString() }, 150);
          balance = await chain.balance(policy.token_id, vaultId);
          say("act", `brought ${money(need)} home from ${market.name}: bills due soon would break the cash buffer. The vault now holds ${money(balance)}`, r.hash);
        } catch (e) {
          say("act", `could not bring savings home from ${market.name}: ${String(e).slice(0, 160)}`);
        }
      }
    }
  }
  const idle = recalled ? null : idleMove(allPayees, balance, buffer, upcoming, o.today, 10n ** BigInt(meta.decimals));
  if (idle) {
    say("forecast", `idle cash: ${money(idle.amount)} above the buffer and the next 14 days of bills, for ${idle.payee}`);
    due.push(idle);
  }
  let available = balance;
  // Vaults that remember paid bills refuse to pay one twice; tag every call with the bill's id.
  const remembers = await chain.view(vaultId, "bill_paid_at", { bill_ref: "probe" }).then(() => true, () => false);
  const ref = (bill: Bill) => (remembers ? { bill_ref: bill.id } : {});

  for (const bill of due) {
    if (remembers && (await recall(chain, vaultId, bill, proposals, handled, o.dryRun, say))) continue;
    if (isCrossChain(bill)) {
      // The vault sees only a 1Click deposit address on that route, so Keel checks the real payee itself.
      const blocked = policy.blocklist.some((b) => b.toLowerCase() === bill.payee.toLowerCase());
      if (blocked) {
        if (!o.dryRun) handled[bill.id] = { action: "refuse", at: new Date().toISOString() };
        say("decide", `refuse, nothing signed: ${bill.memo ?? bill.id} pays ${bill.payee} on ${bill.chain}, which is on the vault's blocklist`);
        continue;
      }
      await crossChain(cfg, chain, vaultId, bill, policy.token_id, proposals, handled, money, o.dryRun, say, ref(bill));
      continue;
    }
    const acct = await chain.account(bill.payee);
    const lastHash = state.codeHashes[bill.payee];
    const isContract = Boolean(acct && acct.codeHash !== "11111111111111111111111111111111");
    if (acct) state.codeHashes[bill.payee] = acct.codeHash;
    const paidBefore = Object.values(handled).filter((h) => h.action === "pay").length + approvalsFor(bill.payee, proposals).length;
    const counterparty = checkCounterparty({
      exists: Boolean(acct),
      isContract,
      codeChanged: Boolean(lastHash && acct && lastHash !== acct.codeHash),
      blocklisted: policy.blocklist.includes(bill.payee),
      allowlisted: policy.allowlist.includes(bill.payee),
      priorPayments: paidBefore,
    });
    const spike = isSpike(bill.amount, approvalsFor(bill.payee, proposals));
    const raw = await chain.checkPayment(vaultId, bill.payee, bill.amount);
    // The vault reports amounts in raw units; show them as tokens.
    const vault = { ...raw, reason: raw.reason.replace(/\b\d{4,}\b/g, (n) => money(BigInt(n))) };
    const action = decide({ bill, policy, balance: available, counterparty, spike, vaultBand: vault.band, vaultReason: vault.reason, today: o.today });
    const label = `${bill.memo ?? bill.id}: ${money(bill.amount)} to ${bill.payee}, due ${bill.due}`;
    say("check", `${label}. Counterparty ${counterparty.verdict} (${counterparty.reasons.join("; ")}). Vault says ${vault.band.replace("_", " ")}`);

    if (action.kind === "wait") {
      say("decide", `wait: ${action.reason}`);
      continue;
    }
    if (action.kind === "defer") {
      // Not marked handled: Keel looks again on the next run.
      say("decide", `defer, nothing signed: ${action.reason}`);
      continue;
    }
    if (action.kind === "refuse") {
      if (!o.dryRun) handled[bill.id] = { action: "refuse", at: new Date().toISOString() };
      say("decide", `refuse, nothing signed: ${action.reason}`);
      continue;
    }
    if (o.dryRun) {
      say("decide", `${action.kind} (dry run, nothing signed): ${action.reason}`);
      continue;
    }
    try {
      if (action.kind === "pay") {
        const lendingDeposit = market?.account_id === bill.payee;
        const r = await chain.callAsAgent(vaultId, "execute_payment", { receiver_id: bill.payee, amount: bill.amount.toString(), memo: bill.memo ?? bill.id, ...ref(bill) }, lendingDeposit ? 200 : 100);
        // The transaction can succeed while the vault declines inside it: a
        // cash-buffer refusal or a failed token transfer both end in false.
        // Nothing was paid, the bill stays open, and Keel looks again next run.
        if (r.value === false) {
          say("act", "the vault did not pay: it would break the cash buffer, or the token transfer failed. The bill stays open", r.hash);
          continue;
        }
        handled[bill.id] = { action: "pay", tx: r.hash, at: new Date().toISOString() };
        available -= bill.amount;
        say("act", `paid alone: ${action.reason}`, r.hash);
      } else {
        const why = await explain(cfg, { company: vaultId.split(".")[0], payee: bill.payee, amount: money(bill.amount), due: bill.due, rule: action.reason, memo: bill.memo });
        const r = await chain.callAsAgent(vaultId, "propose_payment", { receiver_id: bill.payee, amount: bill.amount.toString(), memo: bill.memo ?? bill.id, reason: why.text, ...ref(bill) });
        handled[bill.id] = { action: "propose", tx: r.hash, proposalId: Number(r.value), at: new Date().toISOString() };
        say("act", `proposed #${r.value} for the owner (${why.by === "near-ai" ? "reason written by NEAR AI" : why.by === "claude" ? "reason written by Claude" : "templated reason"}): ${why.text}`, r.hash);
      }
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      const refused = msg.match(/Keel Vault refused: [^"\\]+/);
      say("act", refused ? `the vault refused: ${refused[0]}` : `failed: ${msg.slice(0, 200)}`, (e as { hash?: string }).hash);
    }
  }

  // Learn: draft a higher cap when the same payee keeps needing approval
  const cap = BigInt(policy.per_payment_cap);
  const drafts: RuleDraft[] = [];
  for (const payee of new Set(proposals.map((p) => p.receiver_id))) {
    const d = draftRule(payee, approvalsFor(payee, proposals), cap);
    if (d) drafts.push(d);
  }
  state.drafts[vaultId] = drafts;
  for (const d of drafts) {
    say("learn", `rule draft for ${d.payee}: raise the cap from ${money(d.currentCap)} to ${money(d.suggestedCap)} after approvals of ${d.evidence.map(money).join(", ")}. Only the owner can apply it.`);
  }
}

/**
 * Rebuilds Keel's memory of one bill from the vault, so losing state.json
 * never leads to paying twice. Returns true when the bill needs no action.
 */
async function recall(
  chain: Chain,
  vaultId: string,
  bill: Bill,
  proposals: Proposal[],
  handled: State["handled"][string],
  dryRun: boolean,
  say: (step: string, text: string, tx?: string) => void,
): Promise<boolean> {
  const paidAt = await chain.view<number | null>(vaultId, "bill_paid_at", { bill_ref: bill.id });
  const open = proposals.find(
    (p) => p.bill_ref === bill.id && (["signing", "signed", "executing"].includes(p.status) || (p.status === "pending" && (!p.valid_until_ms || p.valid_until_ms > Date.now()))),
  );
  if (!paidAt && !open) return false;
  const at = new Date(paidAt ?? open!.created_at_ms).toISOString();
  if (!dryRun) {
    handled[bill.id] = open
      ? { action: open.evm || open.valid_until_ms ? "bridge" : "propose", route: open.evm ? "chain-signatures" : open.valid_until_ms ? "intents" : undefined, depositAddress: open.evm ? undefined : open.receiver_id, proposalId: open.id, at }
      : { action: "paid-before", at };
  }
  say("check", `${bill.memo ?? bill.id}: ${open ? `already proposed as #${open.id}, waiting for the owner` : `the vault already paid this bill (${at.slice(0, 16).replace("T", " ")} UTC)`}; nothing to do`);
  return true;
}

/** How many transactions the vault's EVM address has sent: the next nonce. */
async function usedNonces(chain: Chain, vaultId: string, chainId: number): Promise<number> {
  const info = await vaultRoute(chain, vaultId);
  if (!info) return 0;
  const from = await vaultAddress(chain, info.mpc_id, vaultId, info.path);
  return client(chainId).getTransactionCount({ address: from, blockTag: "pending" });
}

/**
 * A bill paid on another chain. Keel tries each route in order and uses the
 * first that works, so one service being down does not stop the bill:
 *
 * 1. NEAR Intents 1Click (mainnet): proposes paying a quote's deposit address,
 *    with valid_until_ms before the quote deadline.
 * 2. NEAR Chain Signatures: proposes a USDC transfer from the vault's own EVM
 *    address. The vault builds the transaction and NEAR's MPC network signs
 *    it after the owner approves. Works on testnet (Base Sepolia).
 *
 * If no route works, nothing is recorded, so the next loop tries again.
 */
async function crossChain(
  cfg: Config,
  chain: Chain,
  vaultId: string,
  bill: Bill,
  tokenId: string,
  proposals: Proposal[],
  handled: State["handled"][string],
  money: (u: bigint) => string,
  dryRun: boolean,
  say: (step: string, text: string, tx?: string) => void,
  billRef: object,
) {
  const label = `${bill.memo ?? bill.id}: ${money(bill.amount)} to ${bill.payee} on ${bill.chain}, due ${bill.due}`;
  const tried: string[] = [];
  for (const route of [viaIntents, viaChainSignatures]) {
    try {
      const done = await route(cfg, chain, vaultId, bill, tokenId, proposals, handled, label, dryRun, say, billRef);
      if (done) return;
    } catch (e) {
      const msg = (e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : String(e));
      tried.push(`${route.name.replace(/^via/, "")}: ${msg.replace(/\s+/g, " ").slice(0, 140)}`);
    }
  }
  say("act", `${label}. No cross-chain route is available right now, so Keel will retry on the next run. ${tried.join(" | ")}`);
}

type Route = (
  cfg: Config,
  chain: Chain,
  vaultId: string,
  bill: Bill,
  tokenId: string,
  proposals: Proposal[],
  handled: State["handled"][string],
  label: string,
  dryRun: boolean,
  say: (step: string, text: string, tx?: string) => void,
  billRef: object,
) => Promise<boolean>;

const viaIntents: Route = async (cfg, chain, vaultId, bill, tokenId, _proposals, handled, label, dryRun, say, billRef) => {
  if (cfg.network !== "mainnet") throw new Error("NEAR Intents runs on mainnet only");
  await intentsTokens(); // health check: throws while 1Click is down
  const from = await chain.view<{ symbol: string; decimals: number }>(tokenId, "ft_metadata");
  const want = bill.token ?? from.symbol;
  const [origin, dest] = await Promise.all([findToken("near", from.symbol), findToken(bill.chain!, want)]);
  // The bill's amount is in the payee's token; the payee must receive all of it.
  const out = (bill.amount * 10n ** BigInt(dest.decimals)) / 10n ** BigInt(from.decimals);
  const q = await quote({
    dry: dryRun,
    swapType: "EXACT_OUTPUT",
    originAsset: origin.assetId,
    destinationAsset: dest.assetId,
    amount: out.toString(),
    recipient: bill.payee,
    refundTo: vaultId,
    deadline: deadlineFromNow(60),
  });
  // Price check with 1Click's own USD prices: refuse a quote that costs more than 3% over the bill's value.
  const valueIn = (Number(q.amountIn) / 10 ** origin.decimals) * origin.price;
  const valueOut = (Number(out) / 10 ** dest.decimals) * dest.price;
  if (valueOut > 0 && valueIn > valueOut * 1.03) {
    throw new Error(`the quote costs $${valueIn.toFixed(2)} for a $${valueOut.toFixed(2)} bill, more than 3% over`);
  }
  const fee = valueOut > 0 ? ` (${(((valueIn - valueOut) / valueOut) * 100).toFixed(2)}% cost)` : "";
  const route = `${q.amountInFormatted} ${from.symbol} in for exactly ${q.amountOutFormatted} ${want} on ${bill.chain}${fee} via NEAR Intents, about ${q.timeEstimate ?? "?"} s`;
  if (dryRun || !q.depositAddress) {
    say("decide", `${label}. Would propose a cross-chain move (dry run): ${route}`);
    return true;
  }
  const validUntil = Date.parse(q.deadline ?? deadlineFromNow(60)) - 2 * 60_000; // two minutes of margin
  const reason = `Cross-chain to ${bill.chain}: ${route}. Approve before ${new Date(validUntil).toISOString().slice(11, 16)} UTC.`;
  const r = await chain.callAsAgent(vaultId, "propose_payment", {
    receiver_id: q.depositAddress,
    amount: q.amountIn, // what the vault must send so the payee gets the whole bill
    memo: bill.memo ?? bill.id,
    reason: reason.slice(0, 270),
    valid_until_ms: validUntil,
    ...billRef,
  });
  handled[bill.id] = { action: "bridge", route: "intents", tx: r.hash, proposalId: Number(r.value), depositAddress: q.depositAddress, at: new Date().toISOString() };
  say("act", `proposed cross-chain move #${r.value}: ${reason}`, r.hash);
  return true;
};

const viaChainSignatures: Route = async (_cfg, chain, vaultId, bill, _tokenId, proposals, handled, label, dryRun, say, billRef) => {
  const info = await vaultRoute(chain, vaultId);
  if (!info) throw new Error("this vault was created before Chain Signatures");
  const route = routeFor(info.routes, bill.chain!);
  if (!route) throw new Error(`the vault has no ${bill.chain} route (it has ${info.routes.map((r) => chainInfo(r.chain_id).name).join(", ") || "none"})`);
  if (bill.token && bill.token.toUpperCase() !== "USDC") throw new Error(`Chain Signatures pays USDC only, not ${bill.token}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(bill.payee)) throw new Error("payee is not a 0x address");
  const from = await vaultAddress(chain, info.mpc_id, vaultId, info.path);
  const units = toTokenUnits(bill.amount, route.decimals);
  const gasToken = chainInfo(route.chain_id).gas;
  const { usdc: onChain, eth } = await balances(route.chain_id, route.token, from);
  if (onChain < units) throw new Error(`the vault's ${bill.chain} address ${from} holds ${usdc(onChain, route.decimals)}, needs ${usdc(units, route.decimals)}; top it up`);
  if (eth === 0n) throw new Error(`the vault's ${bill.chain} address ${from} has no ${gasToken} for gas`);
  // Earlier transfers on this chain that can still be signed keep their nonces; expired offers never will.
  const live = (p: Proposal) => p.status === "signing" || (p.status === "pending" && (!p.valid_until_ms || p.valid_until_ms > Date.now()));
  const reserved = proposals.filter((p) => p.evm && p.evm.chain_id === route.chain_id && live(p)).map((p) => p.evm!.nonce);
  const evm = await prepareTransfer(route, from, bill.payee, units, reserved);
  const where = `from the vault's own ${bill.chain} address ${from.slice(0, 8)}… via NEAR Chain Signatures`;
  if (dryRun) {
    say("decide", `${label}. Would propose paying ${where} (dry run, nonce ${evm.nonce})`);
    return true;
  }
  const validUntil = Date.now() + 30 * 60_000; // nonce and fees go stale
  const reason = `Cross-chain to ${bill.chain}: pay ${bill.payee} ${where}. Approve before ${new Date(validUntil).toISOString().slice(11, 16)} UTC.`;
  const r = await chain.callAsAgent(vaultId, "propose_payment", {
    receiver_id: evm.to,
    amount: bill.amount.toString(),
    memo: bill.memo ?? bill.id,
    reason: reason.slice(0, 270),
    valid_until_ms: validUntil,
    evm,
    ...billRef,
  });
  handled[bill.id] = { action: "bridge", route: "chain-signatures", tx: r.hash, proposalId: Number(r.value), at: new Date().toISOString() };
  say("act", `proposed cross-chain move #${r.value}: ${reason}`, r.hash);
  return true;
};
