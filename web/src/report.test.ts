import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, movementOf } from "./report";
import type { VaultData } from "./vault";

const V = "acme.keel.testnet";
const U = 1_000_000n;
const now = Date.parse("2026-11-09T12:00:00Z");
const day = 86_400_000;

function data(over: Partial<VaultData> = {}): VaultData {
  return {
    policy: { owner_id: "founder.testnet", token_id: "usdc", per_payment_cap: "100000000", daily_cap: "500000000", spent_today: "0", min_balance: "20000000", paused: false, allowlist: ["northwind.testnet"], blocklist: [], agent_key: "ed25519:x" },
    token: { name: "USDC", symbol: "USDC", decimals: 6 } as VaultData["token"],
    balance: (50n * U).toString(),
    gas: 0n,
    proposals: [
      { id: 0, receiver_id: "atlas.testnet", amount: (132n * U).toString(), memo: null, reason: "Atlas is not an approved payee.", status: "pending", created_at_ms: now - day, bill_ref: "atlas-1" },
      { id: 1, receiver_id: "payroll.testnet", amount: (40n * U).toString(), memo: null, reason: "Over the per-payment cap.", status: "executed", created_at_ms: now - 3 * day },
    ],
    bills: [{ id: "northwind", payee: "northwind.testnet", amount: (80n * U).toString(), due: "2026-11-20", monthly: true, category: "software", label: "Northwind", critical: false }],
    paid: {},
    payees: [{ account_id: "northwind.testnet", name: "Northwind", kind: "vendor" }],
    savings: null,
    agentMethods: [],
    history: [
      { at: now - 2 * day, delta: -80n * U, hash: "h-keel", counterparty: "northwind.testnet" },
      { at: now - 3 * day, delta: -40n * U, hash: "h-approve", counterparty: "payroll.testnet" },
      { at: now - 4 * day, delta: -5n * U, hash: "h-withdraw", counterparty: "founder.testnet" },
      { at: now - 5 * day, delta: 175n * U, hash: "h-in", counterparty: "founder.testnet" },
    ],
    multisig: null,
    multisigProposals: [],
    offeredTo: null,
    offerProposals: [],
    ...over,
  };
}

const txs = {
  "h-keel": { signer: V, method: "execute_payment" },
  "h-approve": { signer: "founder.testnet", method: "approve" },
  "h-withdraw": { signer: "founder.testnet", method: "withdraw" },
  "h-in": { signer: "founder.testnet", method: "ft_transfer_call" },
};

const sheet = (name: string, over?: Partial<VaultData>) =>
  buildReport({ vaultId: V, company: "Acme", d: data(over), now, txs, evm: null, explorerTx: "https://x/" }).find((s) => s.name === name)!;

test("ledger: each movement is labelled from the method its transaction called, oldest first, signed amounts", () => {
  const rows = sheet("Ledger").rows;
  assert.deepEqual(rows.map((r) => [r[1], r[2], r[6]]), [
    ["Deposit", 175, "founder.testnet"],
    ["Owner withdrawal", -5, "founder.testnet"],
    ["Payment", -40, "Approved by founder.testnet"],
    ["Payment", -80, "Keel, within the rules"],
  ]);
  assert.equal(rows[3][8], "https://x/h-keel");
});

test("activity: Keel's own payments and every proposal, in time order, with who decided", () => {
  const rows = sheet("Activity").rows;
  assert.deepEqual(rows.map((r) => [r[0], r[2], r[6], r[7]]), [
    [1, "Proposed paying payroll.testnet", "Paid", "You"],
    [2, "Paid Northwind", "Paid", "Keel alone"],
    [3, "Proposed paying atlas.testnet", "Waiting for approval", "Waiting"],
  ]);
  assert.equal(rows[2][10], "Proposal #0, bill atlas-1");
});

test("activity: a multisig owner is named as the decider", () => {
  const rows = sheet("Activity", { multisig: { dao: "team.sputnikv2.testnet", bond: "1", members: ["a", "b"], threshold: [1, 2] } }).rows;
  assert.equal(rows[0][7], "The multisig");
});

test("payments: the bill schedule with status, repeat and the reference that stops a second payment", () => {
  const rows = sheet("Payments").rows;
  assert.equal(rows[0][0], "2026-11-20");
  assert.equal(rows[0][2], "Northwind");
  assert.equal(rows[0][4], 80);
  assert.equal(rows[0][6], "Monthly");
  assert.equal(rows[0][8], "Scheduled");
  assert.match(String(rows[0][11]), /northwind/);
});

test("summary: totals, counts and rules", () => {
  const rows = sheet("Summary").rows;
  const get = (k: string) => rows.find((r) => r[0] === k)?.[1];
  assert.equal(get("Total treasury"), 50);
  assert.equal(get("Paid by Keel alone"), 1);
  assert.equal(get("Proposals approved and paid"), 1);
  assert.equal(get("Waiting for approval"), 1);
  assert.equal(get("Deposits"), 1);
  assert.equal(get("Cash buffer (USDC)"), 20);
});

test("wallets: cash above the buffer", () => {
  const rows = sheet("Wallets").rows;
  assert.deepEqual(rows[0].slice(2, 6), [50, "USDC", 20, 30]);
});

test("money in is a deposit even when another vault's withdraw sent it", () => {
  assert.deepEqual(movementOf(4n, "other.keel.testnet", { signer: "someone.testnet", method: "withdraw" }, V, null), { movement: "Deposit", by: "someone.testnet" });
});

test("payments: blocklisted and past-due bills say so", () => {
  const bills = [
    { id: "scam", payee: "scam.testnet", amount: "1", due: "2026-11-20", monthly: false, label: "Scam" },
    { id: "late", payee: "northwind.testnet", amount: "1", due: "2026-11-01", monthly: false, label: "Late" },
  ];
  const rows = sheet("Payments", { bills, policy: { ...data().policy, blocklist: ["scam.testnet"] } }).rows;
  assert.deepEqual(rows.map((r) => r[8]), ["Overdue", "Blocked: payee on the blocklist"]);
});

test("movement without the archive falls back to the direction", () => {
  assert.deepEqual(movementOf(-1n, "x", undefined, V, null), { movement: "Payment", by: "Unknown" });
  assert.deepEqual(movementOf(1n, "burrow", undefined, V, "burrow"), { movement: "From yield investment", by: "Unknown" });
  assert.equal(movementOf(-1n, "burrow", { signer: V, method: "execute_payment" }, V, "burrow").movement, "To yield investment");
});
