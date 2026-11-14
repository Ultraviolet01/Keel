import { test } from "node:test";
import assert from "node:assert/strict";
import { assessDeposit, chainOfAsset, checkDeposit } from "./intents";

const vault = "anchor.keel.near";
const proposal = { amount: "101330000" };
const bill = { payee: "0x00000000000000000000000000000000000000AA", chain: "base", amount: "100000000" };
const reply = (over: Record<string, unknown> = {}) => ({
  status: "PENDING_DEPOSIT",
  quoteResponse: {
    quoteRequest: { recipient: "0x00000000000000000000000000000000000000aa", refundTo: vault, destinationAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", depositType: "ORIGIN_CHAIN", refundType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", swapType: "EXACT_OUTPUT", appFees: [{ recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: 1 }], virtualChainRecipient: null, virtualChainRefundRecipient: null, ...over },
    quote: { amountIn: "101330000", amountOut: "100000000", amountOutFormatted: "100.0", ...((over as { quote?: object }).quote ?? {}) },
  },
});

test("a deposit address 1Click never issued blocks approval", () => {
  assert.equal(assessDeposit(404, { message: "not found" }, proposal, vault).kind, "unknown");
});

test("a matching 1Click record shows recipient, chain and amount with no problems", () => {
  const d = assessDeposit(200, reply(), proposal, vault, bill);
  assert.equal(d.kind, "known");
  if (d.kind !== "known") return;
  assert.equal(d.recipient, "0x00000000000000000000000000000000000000aa");
  assert.equal(d.chain, "base");
  assert.equal(d.amountOut, "100.0");
  assert.deepEqual(d.problems, []);
});

test("refunds to someone else, or a different amount, are flagged", () => {
  const other = assessDeposit(200, reply({ refundTo: "attacker.near" }), proposal, vault, bill);
  assert.ok(other.kind === "known" && other.problems.some((x) => x.includes("attacker.near")));
  const more = assessDeposit(200, reply(), { amount: "999000000" }, vault, bill);
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

test("a real 1Click quote that pays someone other than the bill's payee, or on another chain, blocks approval", () => {
  // What a stolen agent key could file: a genuine quote to the attacker, refunds to this vault, the bill's amount.
  const toAttacker = assessDeposit(200, reply({ recipient: "0x00000000000000000000000000000000000000ab" }), proposal, vault, bill);
  assert.ok(toAttacker.kind === "known" && toAttacker.problems.some((x) => x.includes("but the bill pays")), JSON.stringify(toAttacker));
  const otherChain = assessDeposit(200, reply({ destinationAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near" }), proposal, vault, bill);
  assert.ok(otherChain.kind === "known" && otherChain.problems.some((x) => x.includes("but the bill is USDC on base")));
  const noBill = assessDeposit(200, reply(), proposal, vault, null);
  assert.ok(noBill.kind === "known" && noBill.problems.some((x) => x.includes("names no bill")));
});

test("1Click must deliver the bill's amount of USDC: another token, or less, blocks approval", () => {
  const junk = assessDeposit(200, reply({ destinationAsset: "nep141:base-0x1111111111111111111111111111111111111111.omft.near" }), proposal, vault, bill);
  assert.ok(junk.kind === "known" && junk.problems.some((x) => x.includes("but the bill is USDC on base")), JSON.stringify(junk));
  const less = assessDeposit(200, { ...reply(), quoteResponse: { ...reply().quoteResponse, quote: { amountIn: "101330000", amountOut: "1000", amountOutFormatted: "0.001" } } }, proposal, vault, bill);
  assert.ok(less.kind === "known" && less.problems.some((x) => x.includes("less than the bill")), JSON.stringify(less));
});

test("Optimism's USDC, in 1Click's other asset format, is recognised", () => {
  const opBill = { ...bill, chain: "op" };
  const d = assessDeposit(200, reply({ destinationAsset: "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ" }), proposal, vault, opBill);
  assert.ok(d.kind === "known" && d.chain === "op" && d.problems.length === 0, JSON.stringify(d));
});

test("a quote that strands refunds, redirects delivery or takes a cut blocks approval", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ refundType: "INTENTS" }, "refundType is INTENTS"],
    [{ recipientType: "INTENTS" }, "recipientType is INTENTS"],
    [{ swapType: "EXACT_INPUT" }, "swapType is EXACT_INPUT"],
    [{ virtualChainRecipient: "attacker.near" }, "redirects funds"],
    [{ appFees: [{ recipient: "attacker.near", fee: 250 }] }, "2.50% in fees for attacker.near"],
    [{ depositType: undefined }, "depositType is missing"],
  ];
  for (const [over, why] of cases) {
    const d = assessDeposit(200, reply(over), proposal, vault, bill);
    assert.ok(d.kind === "known" && d.problems.some((x) => x.includes(why)), `${why}: ${JSON.stringify(d.kind === "known" ? d.problems : d)}`);
  }
  // A genuine quote, with 1Click's own 0.01% fee, passes.
  const ok = assessDeposit(200, reply(), proposal, vault, bill);
  assert.ok(ok.kind === "known" && ok.problems.length === 0, JSON.stringify(ok));
});
