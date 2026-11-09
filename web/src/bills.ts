// Bills the owner lists on the vault with `add_bill`. Keel's agent reads the
// same list and pays each one inside the vault's limits.

/** A bill as the vault stores it. */
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
  added_at_ms?: number;
}

/** One payment of a bill: the bill itself, or this month's or next month's of a monthly bill. */
export interface BillDue {
  bill: VaultBill;
  ref: string; // the bill_ref the payment carries
  due: string;
}

export const CATEGORIES: Record<string, string> = {
  software: "Software and subscriptions",
  hosting: "Domains and hosting",
  contractors: "Contractors",
  payroll: "Payroll",
  rent: "Rent and office",
  taxes: "Taxes",
  card: "Company card top-up",
  other: "Other",
};

/** An approved payee the owner named on the vault. */
export interface VaultPayee {
  account_id: string;
  name: string;
  kind: string;
  keep_at?: string | null;
  /** For a yield destination: the most Keel moves there at once. */
  max_move?: string | null;
  /** A lending market (Burrow): deposits earn in the vault's own account there. */
  lending?: boolean;
}

/** Burrow's lending contract on each network. */
export const BURROW = { testnet: "contract.1638481328.burrow.testnet", mainnet: "contract.main.burrow.near" };

export const PAYEE_KINDS: Record<string, { label: string; note: string }> = {
  vendor: { label: "Vendor", note: "A supplier with a NEAR account" },
  employee: { label: "Employee or contractor", note: "Someone the company pays for work" },
  card: { label: "Company card wallet", note: "The wallet a crypto card spends from; card subscriptions charge the card" },
  offramp: { label: "Bank off-ramp", note: "A deposit address that turns USDC into a bank transfer" },
  own: { label: "Your own wallet", note: "Another wallet the company owns" },
  yield: {
    label: "Yield destination",
    note: "An account the company owns that earns yield. Keel moves only cash above your buffer and the next 14 days of bills, up to the limit you set per move, once a day",
  },
  other: { label: "Other", note: "" },
};

export const BILL_CHAINS: Record<string, string> = { base: "Base", eth: "Ethereum", arb: "Arbitrum", op: "Optimism" };

/**
 * Same rule as the agent (agent/src/brain.ts, vaultBills): a monthly bill is
 * paid as `<id>:<YYYY-MM>` on the day of its first due date, this month and
 * next, never before it starts.
 */
export function billDues(bills: VaultBill[], today: string): BillDue[] {
  const out: BillDue[] = [];
  for (const b of bills) {
    if (b.yearly) {
      const [y0] = today.split("-").map(Number);
      for (const y of [y0, y0 + 1]) {
        const md = b.due.slice(5) === "02-29" && new Date(Date.UTC(y, 1, 29)).getUTCMonth() !== 1 ? "02-28" : b.due.slice(5);
        const due = `${y}-${md}`;
        if (due >= b.due) out.push({ bill: b, ref: `${b.id}:${y}`, due });
      }
      continue;
    }
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

/** Balance points for the chart: the last 14 days from real transfers, the next 14 from unpaid bills. */
export function balanceSeries(
  balance: bigint,
  history: { at: number; delta: bigint }[] | null,
  dues: { due: string; amount: bigint }[],
  now: number,
): { past: { t: number; v: bigint }[]; future: { t: number; v: bigint }[] } {
  const day = 86_400_000;
  const from = now - 14 * day;
  // Walk back from today's balance: before each transfer the vault held balance - delta.
  const past: { t: number; v: bigint }[] = [{ t: now, v: balance }];
  let v = balance;
  for (const h of history ?? []) {
    if (h.at > now) continue;
    if (h.at < from) break;
    past.push({ t: h.at, v }); // just after the transfer
    v -= h.delta;
    past.push({ t: h.at - 1, v }); // just before it
  }
  past.push({ t: from, v });
  past.reverse();
  const future: { t: number; v: bigint }[] = [{ t: now, v: balance }];
  let f = balance;
  for (const x of [...dues].sort((a, b) => a.due.localeCompare(b.due))) {
    const t = Math.max(now, Date.parse(`${x.due}T12:00:00Z`));
    if (t > now + 14 * day) continue;
    future.push({ t, v: f });
    f -= x.amount;
    future.push({ t: t + 1, v: f });
  }
  future.push({ t: now + 14 * day, v: f });
  return { past, future };
}

/**
 * The vault's balance over the last `rangeMs`, ending now: `count + 1`
 * evenly spaced moments plus the moment of every transfer, each worked out
 * as today's balance minus every transfer after it. Used for the portfolio chart.
 */
export function balanceSamples(
  balance: bigint,
  history: { at: number; delta: bigint }[] | null,
  rangeMs: number,
  now: number,
  count = 60,
): { t: number; v: bigint }[] {
  const events = [...(history ?? [])].filter((h) => h.at <= now).sort((a, b) => b.at - a.at);
  const out: { t: number; v: bigint }[] = [];
  for (let i = count; i >= 0; i--) {
    const t = now - (rangeMs * i) / count;
    let v = balance;
    for (const h of events) {
      if (h.at <= t) break;
      v -= h.delta;
    }
    out.push({ t, v: v > 0n ? v : 0n });
  }
  // Every transfer in the range also gets its own points, just before and
  // after it, so a deposit spent minutes later still shows on the line.
  const from = now - rangeMs;
  let after = balance;
  for (const h of events) {
    if (h.at <= from) break;
    const before = after - h.delta;
    out.push({ t: h.at, v: after > 0n ? after : 0n }, { t: h.at - 1, v: before > 0n ? before : 0n });
    after = before;
  }
  return out.sort((a, b) => a.t - b.t);
}
