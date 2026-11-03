// Bills the owner lists on the vault with `add_bill`. Keel's agent reads the
// same list and pays each one inside the vault's limits.

/** A bill as the vault stores it. */
export interface VaultBill {
  id: string;
  payee: string;
  amount: string; // smallest units
  due: string; // YYYY-MM-DD, the first or only due date
  monthly: boolean;
  chain?: string | null;
  label: string;
  memo?: string | null;
  added_at_ms?: number;
}

/** One payment of a bill: the bill itself, or this month's or next month's of a monthly bill. */
export interface BillDue {
  bill: VaultBill;
  ref: string; // the bill_ref the payment carries
  due: string;
}

export const BILL_CHAINS: Record<string, string> = { base: "Base", eth: "Ethereum", arb: "Arbitrum", op: "Optimism" };

/**
 * Same rule as the agent (agent/src/brain.ts, vaultBills): a monthly bill is
 * paid as `<id>:<YYYY-MM>` on the day of its first due date, this month and
 * next, never before it starts.
 */
export function billDues(bills: VaultBill[], today: string): BillDue[] {
  const out: BillDue[] = [];
  for (const b of bills) {
    if (!b.monthly) {
      out.push({ bill: b, ref: b.id, due: b.due });
      continue;
    }
    const day = Number(b.due.slice(8, 10));
    let [y, m] = today.split("-").map(Number);
    for (let i = 0; i < 2; i++) {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const due = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
      if (due >= b.due) out.push({ bill: b, ref: `${b.id}:${due.slice(0, 7)}`, due });
      [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

/** A bill id from its label: lowercase letters, digits and dashes, plus a short random tail. */
export function billId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${slug || "bill"}-${Math.random().toString(36).slice(2, 6)}`;
}

export const isEvmAddress = (s: string) => /^0x[0-9a-f]{40}$/.test(s);
