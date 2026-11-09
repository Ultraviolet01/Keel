import { test } from "node:test";
import assert from "node:assert/strict";
import { balanceSamples, balanceSeries } from "./bills";

const U = 1_000_000n;
const day = 86_400_000;
const now = Date.parse("2026-11-09T12:00:00Z");

test("balance chart: the past rises with deposits and falls with payments, walked back from today's balance", () => {
  // Today 6 held. Newest first: paid 4 two days ago, deposited 10 five days ago.
  const history = [
    { at: now - 2 * day, delta: -4n * U },
    { at: now - 5 * day, delta: 10n * U },
  ];
  const { past } = balanceSeries(6n * U, history, [], now);
  const values = past.map((p) => p.v / U);
  // 14 days ago: 0; after the deposit: 10; after the payment: 6; today: 6.
  assert.deepEqual(values, [0n, 0n, 10n, 10n, 6n, 6n]);
  assert.ok(past.every((p, i) => i === 0 || p.t >= past[i - 1].t), "points are in time order");
});

test("balance chart: the forecast steps down on each unpaid bill and ignores bills past 14 days", () => {
  const { future } = balanceSeries(6n * U, [], [{ due: "2026-11-11", amount: 2n * U }, { due: "2026-12-30", amount: 3n * U }], now);
  assert.deepEqual(future.map((p) => p.v / U), [6n, 6n, 4n, 4n]);
});

test("balance chart: transfers older than 14 days stay out of the window", () => {
  const { past } = balanceSeries(5n * U, [{ at: now - 20 * day, delta: 5n * U }], [], now);
  assert.deepEqual(past.map((p) => p.v / U), [5n, 5n]);
});

test("portfolio samples: even steps over the range, ending at today's balance", () => {
  const history = [{ at: now - 2 * day, delta: -4n * U }, { at: now - 5 * day, delta: 10n * U }];
  const s = balanceSamples(6n * U, history, 7 * day, now, 7);
  assert.equal(s.length, 8 + 4, "8 even samples and 2 points per transfer");
  assert.equal(s[s.length - 1].v, 6n * U, "ends at today's balance");
  assert.deepEqual(s.map((p) => p.v / U), [0n, 0n, 0n, 10n, 10n, 10n, 10n, 10n, 6n, 6n, 6n, 6n]);
  assert.ok(s.every((p, i) => i === 0 || p.t >= s[i - 1].t));
});

test("portfolio samples: money in and out within minutes still shows", () => {
  const history = [{ at: now - 3 * day + 60_000, delta: -6n * U }, { at: now - 3 * day, delta: 6n * U }];
  const s = balanceSamples(0n, history, 14 * day, now, 60);
  assert.ok(s.some((p) => p.v === 6n * U), "the 6 held for a minute is on the line");
});
