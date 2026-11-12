import { test } from "node:test";
import assert from "node:assert/strict";
import { assessDeposit, chainOfAsset, checkDeposit } from "./intents";

const vault = "anchor.keel.near";
const proposal = { amount: "101330000" };
const reply = (over: Record<string, unknown> = {}) => ({
  status: "PENDING_DEPOSIT",
  quoteResponse: {
    quoteRequest: { recipient: "0x00000000000000000000000000000000000000aa", refundTo: vault, destinationAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", ...over },
    quote: { amountIn: "101330000", amountOutFormatted: "100.0" },
  },
});

test("a deposit address 1Click never issued blocks approval", () => {
  assert.equal(assessDeposit(404, { message: "not found" }, proposal, vault).kind, "unknown");
});

test("a matching 1Click record shows recipient, chain and amount with no problems", () => {
  const d = assessDeposit(200, reply(), proposal, vault);
  assert.equal(d.kind, "known");
  if (d.kind !== "known") return;
  assert.equal(d.recipient, "0x00000000000000000000000000000000000000aa");
  assert.equal(d.chain, "base");
  assert.equal(d.amountOut, "100.0");
  assert.deepEqual(d.problems, []);
});

test("refunds to someone else, or a different amount, are flagged", () => {
  const other = assessDeposit(200, reply({ refundTo: "attacker.near" }), proposal, vault);
  assert.ok(other.kind === "known" && other.problems.some((x) => x.includes("attacker.near")));
  const more = assessDeposit(200, reply(), { amount: "999000000" }, vault);
  assert.ok(more.kind === "known" && more.problems.some((x) => x.includes("expects 101330000")));
});

test("server errors are 'unreachable', not approval", () => {
  assert.equal(assessDeposit(521, null, proposal, vault).kind, "unreachable");
});

test("asset ids map to chains", () => {
  assert.equal(chainOfAsset("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"), "arb");
  assert.equal(chainOfAsset("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"), "near");
});

// Calls the real 1Click API, so it runs only when asked: LIVE=1 npm test.
test("live: the real 1Click API says it never issued a made-up address", { skip: process.env.LIVE !== "1" && "set LIVE=1 to call the live 1Click API" }, async () => {
  const d = await checkDeposit("0x0000000000000000000000000000000000000001", proposal, vault);
  assert.equal(d.kind, "unknown", JSON.stringify(d));
});
