// The treasury report: the rows of each sheet in the Excel export, built from
// the vault's live data. No network or browser APIs here, so it is unit-tested.

import type { VaultData } from "./vault";
import { CATEGORIES, billDues } from "./bills";

/** What the transaction behind a token movement called, read from the chain's archive. */
export interface TxInfo {
  signer: string;
  method: string;
}

export type Cell = string | number | null;
export interface Sheet {
  name: string;
  /** Column headers and widths (characters). */
  columns: { header: string; width: number; money?: boolean }[];
  rows: Cell[][];
}

export interface ReportInput {
  vaultId: string;
  company: string;
  d: VaultData;
  now: number;
  /** By transaction hash; missing when the archive could not be read. */
  txs: Record<string, TxInfo>;
  evm: { address: string; chains: { name: string; usdc: bigint; gas: bigint; decimals: number }[] } | null;
  explorerTx: string;
}

const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

/** Smallest units to a plain number for a spreadsheet cell (USDC has 6 decimals, well inside a double). */
export const units = (raw: string | bigint, decimals: number) => Number(BigInt(raw)) / 10 ** decimals;

/** What a movement in or out of the vault was, from the method its transaction called. */
export function movementOf(
  delta: bigint,
  counterparty: string | undefined,
  tx: TxInfo | undefined,
  vaultId: string,
  market: string | null,
): { movement: string; by: string } {
  const toMarket = !!market && counterparty === market;
  // Money in is a deposit, whatever sent it (a wallet, another vault's payout), except the yield investment coming back.
  if (delta > 0n) return { movement: toMarket ? "From yield investment" : "Deposit", by: toMarket && tx?.signer === vaultId ? "Keel" : tx?.signer ?? "Unknown" };
  if (tx) {
    const signer = tx.signer === vaultId ? "Keel" : tx.signer;
    switch (tx.method) {
      case "execute_payment":
        return { movement: toMarket ? "To yield investment" : "Payment", by: "Keel, within the rules" };
      case "recall_from_yield":
        return { movement: "From yield investment", by: signer === "Keel" ? "Keel" : signer };
      case "approve":
        return { movement: "Payment", by: `Approved by ${signer}` };
      case "act_proposal":
        return { movement: "Payment", by: `Approved by the multisig (vote by ${signer})` };
      case "withdraw":
        return { movement: "Owner withdrawal", by: signer };
    }
    return { movement: "Payment", by: signer };
  }
  return { movement: toMarket ? "To yield investment" : "Payment", by: "Unknown" };
}

const BUFFER_RULE = "Approved payee, within the per-payment and daily caps";

export function buildReport(r: ReportInput): Sheet[] {
  const { d, now, vaultId } = r;
  const dec = d.token.decimals;
  const sym = d.token.symbol;
  const u = (raw: string | bigint) => units(raw, dec);
  const market = d.savings?.market ?? null;
  const payeeName = (id: string) => d.payees?.find((p) => p.account_id === id)?.name ?? id;
  const history = d.history ?? [];

  // ---------------------------------------------------------------- ledger
  const ledger: Cell[][] = [];
  const keelPaid: { at: number; to: string; amount: bigint; hash?: string; toMarket: boolean }[] = [];
  let deposits = 0;
  for (const h of [...history].sort((a, b) => a.at - b.at)) {
    const tx = h.hash ? r.txs[h.hash] : undefined;
    const m = movementOf(h.delta, h.counterparty, tx, vaultId, market);
    if (m.movement === "Deposit") deposits++;
    if (tx?.method === "execute_payment" && h.delta < 0n) {
      keelPaid.push({ at: h.at, to: h.counterparty ?? "", amount: -h.delta, hash: h.hash, toMarket: h.counterparty === market });
    }
    ledger.push([iso(h.at), m.movement, u(h.delta), sym, h.counterparty ? payeeName(h.counterparty) : "", h.counterparty ?? "", m.by, h.hash ?? "", h.hash ? r.explorerTx + h.hash : ""]);
  }

  // -------------------------------------------------------------- activity
  type Act = { at: number; row: Cell[] };
  const acts: Act[] = [];
  for (const x of d.proposals) {
    const outcome: Record<string, string> = {
      pending: "Waiting for approval",
      executing: "Paying",
      executed: "Paid",
      rejected: "Rejected",
      failed: "Failed",
      signing: "Being signed",
      signed: "Signed, waiting to send",
      superseded: "Replaced by a newer proposal",
    };
    const decided = x.status === "pending" ? "Waiting" : x.status === "superseded" ? "Keel" : d.multisig ? "The multisig" : "You";
    acts.push({
      at: x.created_at_ms,
      row: [iso(x.created_at_ms), `Proposed paying ${payeeName(x.receiver_id)}`, x.evm ? "Cross-chain" : "Proposal", u(x.amount), sym, outcome[x.status] ?? x.status, decided, "Needs approval", x.reason, x.bill_ref ? `Proposal #${x.id}, bill ${x.bill_ref}` : `Proposal #${x.id}`],
    });
  }
  for (const k of keelPaid) {
    acts.push({
      at: k.at,
      row: [iso(k.at), k.toMarket ? `Moved idle cash to ${payeeName(k.to)}` : `Paid ${payeeName(k.to)}`, k.toMarket ? "Yield" : "Payment", u(k.amount), sym, "Paid", "Keel alone", BUFFER_RULE, k.toMarket ? "Idle cash above the buffer and the next 14 days of bills" : "Inside the founder's limits", k.hash ?? ""],
    });
  }
  acts.sort((a, b) => a.at - b.at);
  const activity = acts.map((a, i) => [i + 1, ...a.row]);

  // -------------------------------------------------------------- payments
  const today = new Date(now).toISOString().slice(0, 10);
  const buffer = BigInt(d.policy.min_balance ?? "0");
  const soon = new Date(now + 3 * 86_400_000).toISOString().slice(0, 10);
  const payments = (d.bills ? billDues(d.bills, today) : [])
    .sort((a, b) => a.due.localeCompare(b.due))
    .map((x) => {
      const prop = d.proposals.find((p) => p.bill_ref === x.ref && ["pending", "executing", "signing", "signed"].includes(p.status));
      const deferred = buffer > 0n && !x.bill.chain && !x.bill.critical && x.due <= soon && x.due > today && BigInt(d.balance) - BigInt(x.bill.amount) < buffer;
      const status = d.paid[x.ref]
        ? "Paid"
        : d.policy.blocklist.includes(x.bill.payee)
          ? "Blocked: payee on the blocklist"
          : prop
            ? prop.status === "pending" ? "Needs approval" : "Paying"
            : deferred
              ? "Deferred: cash buffer"
              : x.due < today
                ? "Overdue"
                : "Scheduled";
      const repeats = x.bill.yearly ? "Yearly" : x.bill.monthly ? "Monthly" : "Once";
      return [x.due, x.bill.label, payeeName(x.bill.payee), CATEGORIES[x.bill.category ?? "other"] ?? x.bill.category ?? "", u(x.bill.amount), sym, repeats, x.bill.chain ?? "NEAR", status, x.bill.critical ? "Yes" : "No", x.bill.memo ?? "", x.ref] as Cell[];
    });

  // --------------------------------------------------------------- wallets
  const cash = BigInt(d.balance);
  const invested = BigInt(d.savings?.units ?? "0");
  const wallets: Cell[][] = [["Vault on NEAR", vaultId, u(cash), sym, u(buffer), u(cash > buffer ? cash - buffer : 0n), "Holds the company's cash; pays by the rules"]];
  if (d.savings) wallets.push([`Yield investment (${d.savings.name})`, d.savings.market, u(invested), sym, null, null, `About ${(d.savings.apr * 100).toFixed(1)}% a year; Keel withdraws it to the vault when bills need it`]);
  for (const c of r.evm?.chains ?? []) {
    wallets.push([`Vault on ${c.name}`, r.evm!.address, units(c.usdc, c.decimals), "USDC", null, null, `${(Number(c.gas) / 1e18).toFixed(5)} ETH for gas; signed by NEAR Chain Signatures`]);
  }

  // --------------------------------------------------------------- summary
  const count = (s: string) => d.proposals.filter((x) => x.status === s).length;
  const evmTotal = (r.evm?.chains ?? []).reduce((s, c) => s + units(c.usdc, c.decimals), 0);
  const p = d.policy;
  const summary: Cell[][] = [
    [`Keel treasury report: ${r.company}`, ""],
    ["Generated", `${iso(now)} UTC`],
    ["Vault", vaultId],
    ["Owner", d.multisig ? `${p.owner_id} (multisig, ${d.multisig.members.length} members)` : p.owner_id],
    ["", ""],
    ["Balances", ""],
    [`Cash in the vault (${sym})`, u(cash)],
    [`Yield investment (${sym})`, u(invested)],
    [`On other chains (USDC)`, evmTotal],
    [`Total treasury`, u(cash) + u(invested) + evmTotal],
    ["", ""],
    ["Activity", ""],
    ["Paid by Keel alone", keelPaid.filter((k) => !k.toMarket).length],
    ["Moved to the yield investment by Keel", keelPaid.filter((k) => k.toMarket).length],
    ["Proposals approved and paid", count("executed")],
    ["Waiting for approval", count("pending")],
    ["Rejected or failed", count("rejected") + count("failed")],
    ["Deposits", deposits],
    ["", ""],
    ["Rules", ""],
    [`Per-payment cap (${sym})`, u(p.per_payment_cap)],
    [`Daily cap (${sym})`, u(p.daily_cap)],
    [`Spent today (${sym})`, u(p.spent_today)],
    [`Cash buffer (${sym})`, u(buffer)],
    ["Payments", p.paused ? "Paused" : "Running"],
    ["Approved payees", p.allowlist.length],
    ["Blocked addresses", p.blocklist.length],
    ["Keel's key", p.agent_key ? "On the vault" : "Removed"],
  ];
  if (!d.history) summary.push(["", ""], ["Note", "The transfer index could not be read, so Ledger and Keel's own payments are missing."]);
  else if (d.history.length === 0 && (cash > 0n || invested > 0n))
    summary.push(["", ""], ["Note", `The public transfer index (nearblocks) lists no ${sym} transfers for this vault, so Ledger and Keel's own payments are empty. Some test tokens are not indexed.`]);

  const money = true;
  return [
    { name: "Summary", columns: [{ header: "", width: 40 }, { header: "", width: 48 }], rows: summary },
    {
      name: "Activity",
      columns: [
        { header: "#", width: 5 },
        { header: "When (UTC)", width: 17 },
        { header: "What happened", width: 34 },
        { header: "Type", width: 11 },
        { header: "Amount", width: 12, money },
        { header: "Token", width: 7 },
        { header: "Outcome", width: 20 },
        { header: "Decided by", width: 14 },
        { header: "Rule checked", width: 30 },
        { header: "Explanation", width: 60 },
        { header: "Reference", width: 46 },
      ],
      rows: activity,
    },
    {
      name: "Payments",
      columns: [
        { header: "Due", width: 11 },
        { header: "Bill", width: 26 },
        { header: "Payee", width: 26 },
        { header: "Category", width: 24 },
        { header: "Amount", width: 12, money },
        { header: "Token", width: 7 },
        { header: "Repeats", width: 9 },
        { header: "Chain", width: 9 },
        { header: "Status", width: 20 },
        { header: "Critical", width: 8 },
        { header: "Memo", width: 30 },
        { header: "Bill reference (paid once)", width: 34 },
      ],
      rows: payments,
    },
    {
      name: "Ledger",
      columns: [
        { header: "When (UTC)", width: 17 },
        { header: "Movement", width: 22 },
        { header: "Amount", width: 12, money },
        { header: "Token", width: 7 },
        { header: "Counterparty", width: 26 },
        { header: "Account", width: 34 },
        { header: "By", width: 34 },
        { header: "Transaction", width: 46 },
        { header: "Link", width: 50 },
      ],
      rows: ledger,
    },
    {
      name: "Wallets",
      columns: [
        { header: "Wallet", width: 32 },
        { header: "Address", width: 44 },
        { header: "Balance", width: 12, money },
        { header: "Token", width: 7 },
        { header: "Cash buffer", width: 12, money },
        { header: "Above buffer", width: 12, money },
        { header: "Note", width: 60 },
      ],
      rows: wallets,
    },
  ];
}
