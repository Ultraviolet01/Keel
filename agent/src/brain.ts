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
  status: "pending" | "executing" | "executed" | "rejected" | "failed" | "signing" | "signed";
  created_at_ms: number;
  valid_until_ms?: number | null;
  /** Set for bills paid from the vault's EVM address through Chain Signatures. */
  evm?: { chain_id: number; token: string; to: string; nonce: number } | null;
  evm_signed?: { raw_tx: string; tx_hash: string } | null;
}

/** A bill the founder told Keel about. Amount in the token's smallest unit. */
export interface Bill {
  id: string;
  payee: string; // a NEAR account, or an address on `chain`
  amount: bigint;
  due: string; // YYYY-MM-DD
  memo?: string;
  chain?: string; // set for payees on another chain, for example "base"
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
  | { kind: "wait"; reason: string };

export interface DecideInput {
  bill: Bill;
  policy: Policy;
  balance: bigint;
  counterparty: Check;
  spike: boolean;
  /** Band from the vault's own check_payment view. */
  vaultBand: "runs_alone" | "needs_approval" | "blocked";
  vaultReason: string;
}

/** What Keel does with one bill that is due. The vault re-checks everything. */
export function decide(x: DecideInput): Action {
  const { bill, policy, balance } = x;
  if (policy.paused) return { kind: "wait", reason: "payments are paused by the owner" };
  if (x.counterparty.verdict === "block") return { kind: "refuse", reason: `refused: ${x.counterparty.reasons.join("; ")}` };
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
