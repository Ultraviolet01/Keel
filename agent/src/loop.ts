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
  isSpike,
  type Bill,
  type RuleDraft,
} from "./brain";
import type { Chain, Config } from "./chain";
import { explain } from "./explain";

const STATE_FILE = resolve(import.meta.dirname, "../state.json");
const LEDGER_FILE = resolve(import.meta.dirname, "../ledger.jsonl");
const BILLS_FILE = resolve(import.meta.dirname, "../../config/bills.json");

export interface State {
  handled: Record<string, Record<string, { action: string; tx?: string; proposalId?: number; at: string }>>;
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

  // Decide and act on bills due soon
  const dueBy = new Date(`${o.today}T00:00:00Z`);
  dueBy.setUTCDate(dueBy.getUTCDate() + o.lookaheadDays);
  const due = open.filter((b) => new Date(`${b.due}T00:00:00Z`) <= dueBy).sort((a, b) => a.due.localeCompare(b.due));
  let available = balance;

  for (const bill of due) {
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
