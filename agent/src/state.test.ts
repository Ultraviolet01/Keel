import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadState, saveState } from "./loop";

test("a half-written or foreign state file is set aside, and Keel starts fresh instead of stopping", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-state-"));
  const file = join(dir, "state.json");
  for (const bad of ['{"handled":{"berth.keel.testnet":{"northwind-nov":{"action":"pa', "null", '"x"', "[]"]) {
    writeFileSync(file, bad);
    assert.deepEqual(loadState(file), { handled: {}, codeHashes: {}, drafts: {} }, bad);
    assert.equal(existsSync(file), false);
  }
  assert.equal(readdirSync(dir).filter((f) => f.includes(".unreadable-")).length, 4); // kept for inspection
});

test("state is saved whole and read back, amounts included", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-state-"));
  const file = join(dir, "state.json");
  const s = { handled: { "berth.keel.testnet": { b: { action: "pay", at: "t" } } }, codeHashes: { x: "h" }, drafts: {}, extra: 5n } as never;
  saveState(s, file);
  assert.deepEqual(loadState(file), s);
  assert.deepEqual(readdirSync(dir), ["state.json"]); // no temporary file left behind
});

test("handled notes are pruned: old and excess ones go, open cross-chain transfers stay", async () => {
  const { pruneHandled, HANDLED_MAX_PER_VAULT } = await import("./loop");
  const now = Date.parse("2026-11-14T00:00:00Z");
  const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
  const h: Record<string, { action: string; at: string; swap?: string }> = {};
  for (let i = 0; i < 5000; i++) h[`spam-${i}`] = { action: "refuse", at: iso(i % 10) };
  h.old = { action: "pay", at: iso(90) };
  h.openBridge = { action: "bridge", at: iso(200) };
  pruneHandled(h as never, now);
  assert.equal(h.old, undefined);
  assert.ok(h.openBridge);
  assert.equal(Object.keys(h).length, HANDLED_MAX_PER_VAULT + 1);
});
