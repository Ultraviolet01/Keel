import { test } from "node:test";
import assert from "node:assert/strict";
import { notable } from "./notify";
import { refusedNotice } from "./loop";

const v = "compass.keel.testnet";
const money = (u: bigint) => `${(Number(u) / 1e6).toFixed(2)} USDC`;
const scam = { id: "urgent-bank-change", payee: "scam-keel.testnet", amount: 4_000_000n, due: "2026-11-05", memo: "URGENT: supplier changed bank details" };

test("a refused bill says which bill, how much, to whom, why, and what to check", () => {
  const n = refusedNotice(v, scam as never, money, "the payee is on Compass's blocklist");
  assert.equal(
    n.text,
    `"URGENT: supplier changed bank details", 4.00 USDC to scam-keel.testnet, due 5 Nov: the payee is on Compass's blocklist, so nothing was signed. If you did not add this bill, check it: someone may be trying to get paid.`,
  );
  assert.equal(n.key, `${v}:refused:urgent-bank-change`);
});

test("two refused bills never share an alert key", () => {
  const a = refusedNotice(v, scam as never, money, "x");
  const b = refusedNotice(v, { ...scam, id: "other-scam" } as never, money, "x");
  assert.notEqual(a.key, b.key);
});

test("only events carrying a notice are reported", () => {
  const notice = refusedNotice(v, scam as never, money, "x");
  assert.deepEqual(notable({ vault: v, step: "decide", text: "refuse, nothing signed: x", notice }), { vault: v, ...notice });
  assert.equal(notable({ vault: v, step: "decide", text: "pay alone: approved payee" }), null);
  assert.equal(notable({ vault: v, step: "forecast", text: "covered for the next 3 days" }), null);
});
