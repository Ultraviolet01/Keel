import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, checkCounterparty, decide, draftRule, firstShortfall, forecast, isCrossChain, isSpike, type DecideInput, type Policy } from "./brain";

const U = 1_000_000n; // 1 USDC

const policy: Policy = {
  owner_id: "kora.testnet",
  agent_key: "ed25519:x",
  token_id: "usdc.testnet",
  per_payment_cap: String(100n * U),
  daily_cap: String(500n * U),
  spent_today: "0",
  paused: false,
  allowlist: ["northwind.testnet"],
  blocklist: ["scam.testnet"],
};

const allow = { verdict: "allow" as const, reasons: ["ok"] };
const base = (over: Partial<DecideInput> = {}): DecideInput => ({
  bill: { id: "b1", payee: "northwind.testnet", amount: 80n * U, due: "2026-11-05" },
  policy,
  balance: 1000n * U,
  counterparty: allow,
  spike: false,
  vaultBand: "runs_alone",
  vaultReason: "allowlisted payee within the per-payment and daily caps",
  ...over,
});

test("pays an allowlisted bill inside the caps", () => {
  assert.equal(decide(base()).kind, "pay");
});

test("proposes when the vault says it needs approval", () => {
  const a = decide(base({ vaultBand: "needs_approval", vaultReason: "over the per-payment cap of 100000000" }));
  assert.equal(a.kind, "propose");
  assert.match(a.reason, /per-payment cap/);
});

test("refuses a blocked counterparty without signing", () => {
  const a = decide(base({ counterparty: { verdict: "block", reasons: ["payee is on the vault's blocklist"] } }));
  assert.equal(a.kind, "refuse");
});

test("a warning always goes to the owner, even inside the caps", () => {
  const a = decide(base({ counterparty: { verdict: "warn", reasons: ["first payment to this payee"] } }));
  assert.equal(a.kind, "propose");
});

test("a spike always goes to the owner", () => {
  assert.equal(decide(base({ spike: true })).kind, "propose");
});

test("waits while the owner has paused payments", () => {
  assert.equal(decide(base({ policy: { ...policy, paused: true } })).kind, "wait");
});

test("proposes instead of paying when the vault is short", () => {
  assert.equal(decide(base({ balance: 10n * U })).kind, "propose");
});

test("counterparty: blocklist and missing accounts are blocked", () => {
  const facts = { exists: true, isContract: false, codeChanged: false, blocklisted: false, allowlisted: true, priorPayments: 2 };
  assert.equal(checkCounterparty(facts).verdict, "allow");
  assert.equal(checkCounterparty({ ...facts, blocklisted: true }).verdict, "block");
  assert.equal(checkCounterparty({ ...facts, exists: false }).verdict, "block");
  assert.equal(checkCounterparty({ ...facts, codeChanged: true }).verdict, "warn");
  assert.equal(checkCounterparty({ ...facts, allowlisted: false, priorPayments: 0 }).verdict, "warn");
});

test("spike: more than 25% above the last 3 bills", () => {
  const hist = [104n * U, 112n * U, 118n * U];
  assert.equal(isSpike(132n * U, hist), false);
  assert.equal(isSpike(150n * U, hist), true);
  assert.equal(isSpike(500n * U, [100n * U]), false, "needs 3 bills of history");
});

test("learn: drafts a higher cap after 3 steady approvals over the cap", () => {
  const d = draftRule("atlas.testnet", [104n * U, 112n * U, 118n * U], 100n * U);
  assert.ok(d);
  assert.equal(d.suggestedCap, 130n * U);
});

test("learn: no draft for a jump or with fewer than 3 approvals", () => {
  assert.equal(draftRule("atlas.testnet", [104n * U, 112n * U], 100n * U), null);
  assert.equal(draftRule("atlas.testnet", [104n * U, 112n * U, 180n * U], 100n * U), null);
  assert.equal(draftRule("atlas.testnet", [60n * U, 70n * U, 80n * U], 100n * U), null, "all under the cap");
});

test("forecast finds the first shortfall", () => {
  const days = forecast(5000n * U, [
    { id: "a", payee: "x", amount: 132n * U, due: "2026-11-05" },
    { id: "b", payee: "y", amount: 9600n * U, due: "2026-11-07" },
  ], "2026-11-02");
  assert.equal(days.length, 14);
  assert.equal(firstShortfall(days)?.date, "2026-11-07");
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
});

import { deadlineFromNow, quoteBody } from "./intents";

test("1Click quote body: exact input, origin-chain deposit, refunds to the vault", () => {
  const body = quoteBody({
    dry: true,
    originAsset: "nep141:usdc.near",
    destinationAsset: "nep141:base-usdc.omft.near",
    amount: "5000000",
    recipient: "0xabc",
    refundTo: "kora.keel.near",
    deadline: deadlineFromNow(30, Date.UTC(2026, 10, 2, 12, 0)),
  });
  assert.equal(body.swapType, "EXACT_INPUT");
  assert.equal(body.depositType, "ORIGIN_CHAIN");
  assert.equal(body.refundType, "ORIGIN_CHAIN");
  assert.equal(body.refundTo, "kora.keel.near");
  assert.equal(body.slippageTolerance, 100);
  assert.equal(body.deadline, "2026-11-02T12:30:00.000Z");
});

test("bills on another chain are cross-chain; NEAR bills are not", () => {
  assert.equal(isCrossChain({ id: "p", payee: "0xabc", amount: 1n, due: "2026-11-05", chain: "base" }), true);
  assert.equal(isCrossChain({ id: "n", payee: "a.testnet", amount: 1n, due: "2026-11-05" }), false);
  assert.equal(isCrossChain({ id: "n", payee: "a.testnet", amount: 1n, due: "2026-11-05", chain: "near" }), false);
});

import { privateKeyToAccount } from "viem/accounts";
import { addressFromNearKey } from "./evm";

test("Chain Signatures: a NEAR secp256k1 key maps to the right EVM address", () => {
  const acct = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const point = Buffer.from(acct.publicKey.slice(4), "hex"); // drop 0x04
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${point.toString("hex")}`), b58 = "";
  while (n > 0n) { b58 = ALPHABET[Number(n % 58n)] + b58; n /= 58n; }
  assert.equal(addressFromNearKey(`secp256k1:${b58}`).toLowerCase(), acct.address.toLowerCase());
});

import { nextNonce } from "./evm";

test("Chain Signatures: each transfer gets a free nonce; used ones are skipped", () => {
  assert.equal(nextNonce(1, []), 1);
  assert.equal(nextNonce(1, [0]), 1, "a stale proposal at nonce 0 does not push the next one up");
  assert.equal(nextNonce(1, [1, 2]), 3);
  assert.equal(nextNonce(1, [2]), 1);
});
