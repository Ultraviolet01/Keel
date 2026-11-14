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
