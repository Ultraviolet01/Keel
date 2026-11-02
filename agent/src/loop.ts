// One round of Keel's loop for one vault:
// observe -> forecast -> check -> decide -> act -> learn.

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  addDays,
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
import { balances, broadcast, chainInfo, client, prepareTransfer, receipt, usdc, vaultAddress, vaultRoute } from "./evm";

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
}

export function loadBills(vaultId: string, decimals: number, today: string): Bill[] {
  if (!existsSync(BILLS_FILE)) return [];
  const all = JSON.parse(readFileSync(BILLS_FILE, "utf8")) as Record<string, RawBill[]>;
  return (all[vaultId] ?? []).map((b) => ({
    ...b,
    amount: toUnits(b.amount, decimals),
    due: b.due.startsWith("+") ? addDays(today, Number(b.due.slice(1))) : b.due,
  }));
}

export function toUnits(text: string, decimals: number): bigint {
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
  if (!("agent_key" in policy) || policy.agent_key !== chain.agentPublicKey()) {
    say("observe", "skipped: this vault does not hold Keel's current agent key");
    return;
  }
  const meta = await chain.view<{ symbol: string; decimals: number }>(policy.token_id, "ft_metadata");
  const [balance, proposals] = await Promise.all([chain.balance(policy.token_id, vaultId), chain.proposals(vaultId)]);
  const money = (u: bigint) => fmt(u, meta.decimals, meta.symbol);
  const bills = loadBills(vaultId, meta.decimals, o.today);
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
    if (p.status === "signed" && !Object.values(handled).some((h) => h.proposalId === p.id)) {
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
          if (!h.evmTx && o.dryRun) {
            say("reconcile", `${id}: #${p.id} is signed; would broadcast it (dry run)`);
            continue;
          }
          if (!h.evmTx) {
            if ((await broadcast(p.evm.chain_id, raw_tx as `0x${string}`, tx_hash as `0x${string}`)) === "stale") {
              delete handled[id];
              say("reconcile", `${id}: #${p.id} was signed with a nonce another transfer already used; Keel will propose it again`);
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
  const due = open.filter((b) => new Date(`${b.due}T00:00:00Z`) <= dueBy).sort((a, b) => a.due.localeCompare(b.due));
  let available = balance;

  for (const bill of due) {
    if (isCrossChain(bill)) {
      await crossChain(cfg, chain, vaultId, bill, policy.token_id, proposals, handled, money, o.dryRun, say);
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
    const action = decide({ bill, policy, balance: available, counterparty, spike, vaultBand: vault.band, vaultReason: vault.reason });
    const label = `${bill.memo ?? bill.id}: ${money(bill.amount)} to ${bill.payee}, due ${bill.due}`;
    say("check", `${label}. Counterparty ${counterparty.verdict} (${counterparty.reasons.join("; ")}). Vault says ${vault.band.replace("_", " ")}`);

    if (action.kind === "wait") {
      say("decide", `wait: ${action.reason}`);
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
        const r = await chain.callAsAgent(vaultId, "execute_payment", { receiver_id: bill.payee, amount: bill.amount.toString(), memo: bill.memo ?? bill.id });
        handled[bill.id] = { action: "pay", tx: r.hash, at: new Date().toISOString() };
        available -= bill.amount;
        say("act", `paid alone: ${action.reason}`, r.hash);
      } else {
        const why = await explain(cfg, { company: vaultId.split(".")[0], payee: bill.payee, amount: money(bill.amount), due: bill.due, rule: action.reason, memo: bill.memo });
        const r = await chain.callAsAgent(vaultId, "propose_payment", { receiver_id: bill.payee, amount: bill.amount.toString(), memo: bill.memo ?? bill.id, reason: why.text });
        handled[bill.id] = { action: "propose", tx: r.hash, proposalId: Number(r.value), at: new Date().toISOString() };
        say("act", `proposed #${r.value} for the owner (${why.by === "near-ai" ? "reason written by NEAR AI" : "templated reason"}): ${why.text}`, r.hash);
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
) {
  const label = `${bill.memo ?? bill.id}: ${money(bill.amount)} to ${bill.payee} on ${bill.chain}, due ${bill.due}`;
  const tried: string[] = [];
  for (const route of [viaIntents, viaChainSignatures]) {
    try {
      const done = await route(cfg, chain, vaultId, bill, tokenId, proposals, handled, label, dryRun, say);
      if (done) return;
    } catch (e) {
      tried.push(`${route.name.replace(/^via/, "")}: ${String(e instanceof Error ? e.message : e).slice(0, 140)}`);
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
) => Promise<boolean>;

const viaIntents: Route = async (cfg, chain, vaultId, bill, tokenId, _proposals, handled, label, dryRun, say) => {
  if (cfg.network !== "mainnet") throw new Error("NEAR Intents runs on mainnet only");
  await intentsTokens(); // health check: throws while 1Click is down
  const from = await chain.view<{ symbol: string }>(tokenId, "ft_metadata");
  const [origin, dest] = await Promise.all([findToken("near", from.symbol), findToken(bill.chain!, from.symbol)]);
  const q = await quote({
    dry: dryRun,
    originAsset: origin.assetId,
    destinationAsset: dest.assetId,
    amount: bill.amount.toString(),
    recipient: bill.payee,
    refundTo: vaultId,
    deadline: deadlineFromNow(60),
  });
  const route = `${q.amountInFormatted} in, at least ${q.minAmountOut} out on ${bill.chain} via NEAR Intents, about ${q.timeEstimate ?? "?"} s`;
  if (dryRun || !q.depositAddress) {
    say("decide", `${label}. Would propose a cross-chain move (dry run): ${route}`);
    return true;
  }
  const validUntil = Date.parse(q.deadline ?? deadlineFromNow(60)) - 2 * 60_000; // two minutes of margin
  const reason = `Cross-chain to ${bill.chain}: ${route}. Approve before ${new Date(validUntil).toISOString().slice(11, 16)} UTC.`;
  const r = await chain.callAsAgent(vaultId, "propose_payment", {
    receiver_id: q.depositAddress,
    amount: bill.amount.toString(),
    memo: bill.memo ?? bill.id,
    reason: reason.slice(0, 270),
    valid_until_ms: validUntil,
  });
  handled[bill.id] = { action: "bridge", route: "intents", tx: r.hash, proposalId: Number(r.value), depositAddress: q.depositAddress, at: new Date().toISOString() };
  say("act", `proposed cross-chain move #${r.value}: ${reason}`, r.hash);
  return true;
};

const viaChainSignatures: Route = async (_cfg, chain, vaultId, bill, _tokenId, proposals, handled, label, dryRun, say) => {
  const info = await vaultRoute(chain, vaultId);
  if (!info) throw new Error("this vault was created before Chain Signatures");
  if (!info.route) throw new Error("the owner turned the vault's EVM route off");
  const route = info.route;
  if (chainInfo(route.chain_id).name !== bill.chain) throw new Error(`the vault's EVM route is not ${bill.chain}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(bill.payee)) throw new Error("payee is not a 0x address");
  const from = await vaultAddress(chain, info.mpc_id, vaultId, info.path);
  const { usdc: onChain, eth } = await balances(route.chain_id, route.token, from);
  if (onChain < bill.amount) throw new Error(`the vault's ${bill.chain} address ${from} holds ${usdc(onChain)}, needs ${usdc(bill.amount)}; top it up`);
  if (eth === 0n) throw new Error(`the vault's ${bill.chain} address ${from} has no ETH for gas`);
  // Earlier transfers that can still be signed keep their nonces; expired offers never will.
  const live = (p: Proposal) => p.status === "signing" || (p.status === "pending" && (!p.valid_until_ms || p.valid_until_ms > Date.now()));
  const reserved = proposals.filter((p) => p.evm && live(p)).map((p) => p.evm!.nonce);
  const evm = await prepareTransfer(route, from, bill.payee, bill.amount, reserved);
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
  });
  handled[bill.id] = { action: "bridge", route: "chain-signatures", tx: r.hash, proposalId: Number(r.value), at: new Date().toISOString() };
  say("act", `proposed cross-chain move #${r.value}: ${reason}`, r.hash);
  return true;
};
