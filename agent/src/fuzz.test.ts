// Randomized checks: thousands of generated cases per rule, with a fixed seed
// so any failure can be replayed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCounterparty, decide, draftRule, forecast, isSpike, type DecideInput, type Policy } from "./brain";
import { fmt, toUnits } from "./loop";

let seed = 0x6b65656c; // "keel"
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const big = (max: number) => BigInt(Math.floor(rnd() * max));
const U = 1_000_000n;

function randomInput(): DecideInput {
  const policy: Policy = {
    owner_id: "o.testnet", agent_key: "k", token_id: "t", per_payment_cap: String(big(500) * U), daily_cap: String(big(2000) * U),
    spent_today: String(big(2000) * U), paused: rnd() < 0.2, allowlist: ["a.testnet"], blocklist: ["evil.testnet"],
  };
  const facts = { exists: rnd() > 0.1, isContract: rnd() < 0.3, codeChanged: rnd() < 0.2, blocklisted: rnd() < 0.2, allowlisted: rnd() < 0.5, priorPayments: Math.floor(rnd() * 4) };
  return {
    bill: { id: "b", payee: pick(["a.testnet", "evil.testnet", "new.testnet"]), amount: big(1000) * U + 1n, due: "2026-11-05" },
    policy,
    balance: big(3000) * U,
    counterparty: checkCounterparty(facts),
    spike: rnd() < 0.2,
    vaultBand: pick(["runs_alone", "needs_approval", "blocked"] as const),
    vaultReason: pick(["allowlisted payee within the per-payment and daily caps", "payee is on the blocklist", "daily cap reached", "over the per-payment cap"]),
  };
}

test("fuzz: Keel only pays when every guard agrees (20,000 cases)", () => {
  for (let i = 0; i < 20_000; i++) {
    const x = randomInput();
    const a = decide(x);
    if (a.kind === "pay") {
      assert.ok(!x.policy.paused, "never pays while paused");
      assert.equal(x.counterparty.verdict, "allow", "never pays a warned or blocked payee");
      assert.ok(!x.spike, "never pays a spike");
      assert.ok(x.balance >= x.bill.amount, "never pays more than the balance");
      assert.equal(x.vaultBand, "runs_alone", "never pays what the vault would not run alone");
    }
    if (x.counterparty.verdict === "block") assert.equal(a.kind === "pay" || a.kind === "propose", false, "a blocked payee is never paid or proposed");
  }
});

test("fuzz: forecast balance always equals start minus every bill due in the window", () => {
  for (let i = 0; i < 2_000; i++) {
    const start = big(10_000) * U;
    const bills = Array.from({ length: Math.floor(rnd() * 12) }, (_, k) => ({ id: `${k}`, payee: "p", amount: big(900) * U, due: `2026-11-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}` }));
    const days = forecast(start, bills, "2026-11-02", 14);
    const inWindow = bills.filter((b) => b.due <= days.at(-1)!.date).reduce((s, b) => s + b.amount, 0n);
    assert.equal(days.at(-1)!.balance, start - inWindow);
    for (let d = 1; d < days.length; d++) assert.ok(days[d].balance <= days[d - 1].balance, "balance never rises without income");
  }
});

test("fuzz: a rule draft never suggests a cap below what the owner approved", () => {
  for (let i = 0; i < 5_000; i++) {
    const approvals = Array.from({ length: Math.floor(rnd() * 6) }, () => big(400) * U + 1n);
    const cap = big(300) * U;
    const d = draftRule("p", approvals, cap);
    if (d) {
      assert.ok(d.suggestedCap >= d.evidence.reduce((m, a) => (a > m ? a : m), 0n));
      assert.ok(d.suggestedCap > cap);
    }
  }
});

test("fuzz: spike detection is monotonic in the amount", () => {
  for (let i = 0; i < 5_000; i++) {
    const hist = [big(500) * U + 1n, big(500) * U + 1n, big(500) * U + 1n];
    const a = big(1000) * U;
    if (isSpike(a, hist)) assert.ok(isSpike(a + U, hist), "a bigger amount is at least as suspicious");
  }
});

test("fuzz: amounts survive a round trip through toUnits and fmt", () => {
  for (let i = 0; i < 5_000; i++) {
    const cents = big(1e9);
    const text = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
    const units = toUnits(text, 6);
    assert.equal(units, cents * 10_000n);
    assert.equal(fmt(units, 6).replace(/,/g, ""), text);
  }
});

test("bill amounts: negative, empty, scientific or garbage text is rejected, not parsed", () => {
  for (const bad of ["-5", "-0.5", "", "abc", "1e3", "12.3.4", "0x10", " 5", "5 USDC", "NaN", "Infinity"]) {
    assert.throws(() => toUnits(bad, 6), `"${bad}" should be rejected`);
  }
  assert.equal(toUnits("1,234.5", 6), 1_234_500_000n);
  assert.equal(toUnits("0.0000009", 6), 0n, "below one unit rounds down");
});
