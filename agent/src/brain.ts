// Keel's decisions, as plain functions with no network access, so every rule
// can be tested. The vault contract enforces the limits again on chain; these
// functions decide what the agent should ask for.

export interface Policy {
  owner_id: string;
  agent_key?: string | null;
  token_id: string;
  per_payment_cap: string;
  daily_cap: string;
  spent_today: string;
  /** Cash buffer the agent's payments must leave in the vault; missing on older vaults. */
  min_balance?: string;
  paused: boolean;
  allowlist: string[];
  blocklist: string[];
}

export interface Proposal {
  id: number;
  receiver_id: string;
  amount: string;
  memo: string | null;
  reason: string;
  status: "pending" | "executing" | "executed" | "rejected" | "failed" | "signing" | "signed" | "superseded";
  created_at_ms: number;
  valid_until_ms?: number | null;
  /** Set for bills paid from the vault's EVM address through Chain Signatures. */
  evm?: { chain_id: number; token: string; to: string; nonce: number } | null;
  evm_signed?: { raw_tx: string; tx_hash: string } | null;
  /** The bill this proposal pays; the vault pays each bill at most once. */
  bill_ref?: string | null;
}

/** A bill the founder told Keel about. Amount in the token's smallest unit. */
export interface Bill {
  id: string;
  payee: string; // a NEAR account, or an address on `chain`
  amount: bigint;
  due: string; // YYYY-MM-DD
  memo?: string;
  chain?: string; // set for payees on another chain, for example "base", "eth", "arb", "op"
  token?: string; // what the payee wants on that chain, for example "USDT"; default the vault's token
  critical?: boolean; // paid first, and never deferred for the cash buffer
}

/** A bill as the vault stores it, listed by the owner with `add_bill`. */
export interface VaultBill {
  id: string;
  payee: string;
  amount: string; // smallest units
  due: string; // YYYY-MM-DD, the first or only due date
  monthly: boolean;
  yearly?: boolean;
  category?: string | null;
  critical?: boolean;
  chain?: string | null;
  label: string;
  memo?: string | null;
}

/** An approved payee the owner named on the vault. */
export interface VaultPayee {
  account_id: string;
  name: string;
  kind: string;
  keep_at?: string | null; // smallest units; Keel tops a card or own wallet up to this
}

/**
 * Top-ups for the owner's card and own wallets that hold less than their
 * keep_at. Each is an ordinary bill for today, so it goes through the same
 * checks: within the caps Keel sends it, otherwise it proposes it. The bill id
 * carries the date, so the vault allows at most one top-up per wallet per day.
 */
export function topUps(payees: VaultPayee[], balances: Record<string, bigint>, today: string): Bill[] {
  const out: Bill[] = [];
  for (const p of payees) {
    if (!p.keep_at) continue;
    const target = BigInt(p.keep_at);
    const has = balances[p.account_id] ?? 0n;
    if (has >= target) continue;
    out.push({ id: `top:${p.account_id.slice(0, 45)}:${today}`, payee: p.account_id, amount: target - has, due: today, memo: `Top up ${p.name} to its target balance` });
  }
  return out;
}

/**
 * The owner's bills as Keel pays them. A one-off bill is paid once under its
 * id. A monthly bill is paid once a month as `<id>:<YYYY-MM>`, on the same day
 * of the month as its first due date (the last day in shorter months). Only
 * this month and next are produced, and none before the first due date, so a
 * new monthly bill never pays months that already went by.
 */
export function vaultBills(raw: VaultBill[], today: string): Bill[] {
  const out: Bill[] = [];
  for (const b of raw) {
    const base = {
      payee: b.payee,
      amount: BigInt(b.amount),
      memo: b.memo ? `${b.label}: ${b.memo}` : b.label,
      ...(b.chain ? { chain: b.chain } : {}),
      ...(b.critical ? { critical: true } : {}),
    };
    if (b.yearly) {
      // Same month and day every year; 29 February falls on the 28th in other years.
      const [y0] = today.split("-").map(Number);
      for (const y of [y0, y0 + 1]) {
        const md = b.due.slice(5) === "02-29" && new Date(Date.UTC(y, 1, 29)).getUTCMonth() !== 1 ? "02-28" : b.due.slice(5);
        const due = `${y}-${md}`;
        if (due >= b.due) out.push({ ...base, id: `${b.id}:${y}`, due });
      }
      continue;
    }
    if (!b.monthly) {
      out.push({ ...base, id: b.id, due: b.due });
      continue;
    }
    const day = Number(b.due.slice(8, 10));
    let [y, m] = today.split("-").map(Number);
    for (let i = 0; i < 2; i++) {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const due = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
      if (due >= b.due) out.push({ ...base, id: `${b.id}:${due.slice(0, 7)}`, due });
      [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
    }
  }
  return out;
}

/** Bills paid on another chain go through NEAR Intents and always need the owner. */
export function isCrossChain(b: Bill): boolean {
  return Boolean(b.chain && b.chain !== "near");
}

export interface PaymentRecord {
  payee: string;
  amount: bigint;
  approvedByOwner: boolean;
}

// ----------------------------------------------------------------- forecast

export interface ForecastDay {
  date: string;
  out: bigint;
  balance: bigint;
}

/** Balance at the end of each of the next `days` days, with bills paid on their due date. */
export function forecast(balance: bigint, bills: Bill[], today: string, days = 14): ForecastDay[] {
  const out: ForecastDay[] = [];
  let running = balance;
  for (let i = 0; i < days; i++) {
    const date = addDays(today, i);
    const due = bills.filter((b) => b.due === date || (i === 0 && b.due < today));
    const spend = due.reduce((s, b) => s + b.amount, 0n);
    running -= spend;
    out.push({ date, out: spend, balance: running });
  }
  return out;
}

export function firstShortfall(days: ForecastDay[]): ForecastDay | undefined {
  return days.find((d) => d.balance < 0n);
}

export function addDays(date: string, n: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// ------------------------------------------------------------- counterparty

export type Verdict = "allow" | "warn" | "block";

export interface CounterpartyFacts {
  exists: boolean;
  isContract: boolean;
  codeChanged: boolean; // code hash differs from the one Keel saw last time
  blocklisted: boolean;
  allowlisted: boolean;
  priorPayments: number; // payments this vault already made to the payee
}

export interface Check {
  verdict: Verdict;
  reasons: string[];
}

/** Allow, warn or block a receiver before anything is signed. */
export function checkCounterparty(f: CounterpartyFacts): Check {
  if (f.blocklisted) return { verdict: "block", reasons: ["payee is on the vault's blocklist"] };
  if (!f.exists) return { verdict: "block", reasons: ["payee account does not exist"] };
  const warn: string[] = [];
  if (f.codeChanged) warn.push("payee is a contract whose code changed since Keel last saw it");
  if (!f.allowlisted) warn.push("payee is not on the allowlist");
  if (f.priorPayments === 0 && !f.allowlisted) warn.push("first payment to this payee");
  return warn.length ? { verdict: "warn", reasons: warn } : { verdict: "allow", reasons: ["allowlisted payee, paid before or approved by the owner"] };
}

// ------------------------------------------------------------------- spikes

/** A bill more than `pct`% above the average of the payee's last 3 is a possible fraud or error. */
export function isSpike(amount: bigint, history: bigint[], pct = 25): boolean {
  const last = history.slice(-3);
  if (last.length < 3) return false;
  const avg = last.reduce((s, x) => s + x, 0n) / BigInt(last.length);
  return amount * 100n > avg * BigInt(100 + pct);
}

// ------------------------------------------------------------------- decide

export type Action =
  | { kind: "pay"; reason: string }
  | { kind: "propose"; reason: string }
  | { kind: "refuse"; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "defer"; reason: string };

export interface DecideInput {
  bill: Bill;
  policy: Policy;
  balance: bigint;
  counterparty: Check;
  spike: boolean;
  /** Band from the vault's own check_payment view. */
  vaultBand: "runs_alone" | "needs_approval" | "blocked";
  vaultReason: string;
  /** Today, YYYY-MM-DD; a deferred bill comes to the owner once it is due. */
  today?: string;
}

/** What Keel does with one bill that is due. The vault re-checks everything. */
export function decide(x: DecideInput): Action {
  const { bill, policy, balance } = x;
  if (policy.paused) return { kind: "wait", reason: "payments are paused by the owner" };
  if (x.counterparty.verdict === "block") return { kind: "refuse", reason: `refused: ${x.counterparty.reasons.join("; ")}` };
  // Cash buffer: a payment may not leave the vault below the owner's minimum.
  // The vault enforces it too; Keel decides what to do instead of paying.
  const buffer = BigInt(policy.min_balance ?? "0");
  if (buffer > 0n && balance - bill.amount < buffer) {
    if (bill.critical) return { kind: "propose", reason: "critical bill, but paying it would take the vault below your cash buffer; approve to pay it anyway" };
    if (x.today && bill.due > x.today) return { kind: "defer", reason: "paying it now would take the vault below your cash buffer; waiting until it is due or more cash comes in" };
    return { kind: "propose", reason: "due now, but paying it would take the vault below your cash buffer; approve to pay it anyway or deposit more" };
  }
  if (balance < bill.amount) {
    return { kind: "propose", reason: `vault holds less than this bill; needs a deposit or your approval to wait` };
  }
  if (x.spike) return { kind: "propose", reason: "possible spike: more than 25% above this payee's last 3 bills" };
  if (x.counterparty.verdict === "warn") return { kind: "propose", reason: x.counterparty.reasons.join("; ") };
  if (x.vaultBand === "runs_alone") return { kind: "pay", reason: x.vaultReason };
  if (x.vaultBand === "blocked" && /blocklist/.test(x.vaultReason)) return { kind: "refuse", reason: `refused: ${x.vaultReason}` };
  return { kind: "propose", reason: x.vaultReason };
}

// -------------------------------------------------------------------- learn

export interface RuleDraft {
  payee: string;
  currentCap: bigint;
  suggestedCap: bigint;
  evidence: bigint[];
}

/**
 * Drafts a higher cap when the same payee needed the owner's approval three
 * times in a row with bills rising steadily (each within 25% of the last).
 * Keel never applies it; the owner signs update_policy if they agree.
 */
export function draftRule(payee: string, approvals: bigint[], currentCap: bigint): RuleDraft | null {
  const last = approvals.slice(-3);
  if (last.length < 3 || currentCap === 0n) return null;
  const allOverCap = last.every((a) => a > currentCap);
  const steady = last.every((a, i) => i === 0 || (a >= last[i - 1] && a * 100n <= last[i - 1] * 125n));
  if (!allOverCap || !steady) return null;
  const max = last.reduce((m, a) => (a > m ? a : m), 0n);
  const unit = 10n ** 6n; // round the suggestion up to a whole token unit, plus 10% room
  const suggested = (((max * 110n) / 100n + unit - 1n) / unit) * unit;
  return { payee, currentCap, suggestedCap: suggested, evidence: last };
}

/** Amounts the owner approved for one payee, oldest first, from the vault's proposals. */
export function approvalsFor(payee: string, proposals: Proposal[]): bigint[] {
  return proposals.filter((p) => p.receiver_id === payee && p.status === "executed").map((p) => BigInt(p.amount));
}
