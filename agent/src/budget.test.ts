import { test } from "node:test";
import assert from "node:assert/strict";
import { budget, budgetedReview, REVIEWS_PER_VAULT, rotate } from "./loop";
import type { Config } from "./chain";

// No AI key and no network: review() returns null quickly, so only the budget is under test.
const cfg = { anthropicModel: "x", nearAiUrl: "https://x", nearAiModel: "m" } as Config;
const input = { company: "a", payee: "atlas.testnet", amount: "1", due: "d", history: [], knownPayees: [] };

test("one vault gets at most a fixed number of AI reviews per round; the rest wait", async () => {
  budget.reviews = 0;
  budget.deadline = Infinity;
  const results = [];
  for (let i = 0; i < 50; i++) results.push(await budgetedReview(cfg, input));
  assert.equal(results.filter((r) => r !== "later").length, REVIEWS_PER_VAULT);
  assert.equal(results.filter((r) => r === "later").length, 50 - REVIEWS_PER_VAULT);
});

test("past the vault's time budget, no review starts", async () => {
  budget.reviews = 0;
  budget.deadline = Date.now() - 1;
  assert.equal(await budgetedReview(cfg, input), "later");
});

test("the vault order rotates every round, so no vault is always last", () => {
  const v = ["a", "b", "c", "d"];
  assert.deepEqual(rotate(v, 0), ["a", "b", "c", "d"]);
  assert.deepEqual(rotate(v, 1), ["b", "c", "d", "a"]);
  assert.deepEqual(rotate(v, 6), ["c", "d", "a", "b"]);
  const firsts = new Set(Array.from({ length: 4 }, (_, r) => rotate(v, r)[0]));
  assert.equal(firsts.size, 4);
  assert.deepEqual(rotate([], 3), []);
});

test("two cross-chain transfers on one chain never share a nonce, in one round or across rounds", async () => {
  const { reservedNonces } = await import("./loop");
  const { nextNonce } = await import("./evm");
  const p = (id: number, status: string, nonce: number, extra = {}) => ({ id, status, evm: { chain_id: 11155111, nonce }, ...extra }) as never;
  // The bug seen live: two bills in one round both got nonce 0. The first's nonce is reserved for the round.
  assert.equal(nextNonce(0, reservedNonces([], 11155111, [0])), 1);
  // Signed but not yet mined (broadcast pending or failed): its nonce stays taken.
  assert.equal(nextNonce(0, reservedNonces([p(18, "signed", 0)], 11155111, [])), 1);
  // Already mined: the chain's nonce has passed it, so it does not push the next one up.
  assert.equal(nextNonce(1, reservedNonces([p(18, "signed", 0)], 11155111, [])), 1);
  // An expired offer never lands, so its nonce is free again; another chain's nonces do not count.
  assert.equal(nextNonce(0, reservedNonces([p(5, "pending", 0, { valid_until_ms: 1 }), { id: 6, status: "pending", evm: { chain_id: 421614, nonce: 0 } } as never], 11155111, [], 10)), 0);
});

test("a bill the owner released after a lost transfer is proposed again, not skipped forever", async () => {
  const { inFlight } = await import("./loop");
  const signed = { id: 19, status: "signed", bill_ref: "b" } as never;
  assert.equal(inFlight(signed, 1794657000000), true); // bill still marked paid: the transfer stands
  assert.equal(inFlight(signed, null), false); // the owner released the bill: the lost transfer no longer stands
  assert.equal(inFlight({ id: 1, status: "pending" } as never, null), true);
  assert.equal(inFlight({ id: 2, status: "pending", valid_until_ms: 5 } as never, null, 10), false);
  assert.equal(inFlight({ id: 3, status: "rejected" } as never, 1), false);
});
