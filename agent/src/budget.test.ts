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
