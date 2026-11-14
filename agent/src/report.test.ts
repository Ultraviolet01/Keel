import { test } from "node:test";
import assert from "node:assert/strict";
import { REPORT_MAX_BYTES, REPORT_PER_VAULT, reportBody } from "./notify";

const memo = "x".repeat(280);
const ev = (vault: string, i: number) => ({ vault, kind: "refused" as const, key: `${vault}:refused:b${i}`, text: `"${memo}", 4.00 USDC to scam-keel.testnet, due 9 Nov: the payee is on the blocklist, so nothing was signed.` });

test("hostile vaults cannot push the report over the server's limit or another vault's alert out of it", () => {
  const events = [];
  for (let v = 0; v < 40; v++) for (let i = 0; i < 50; i++) events.push(ev(`evil${v}.keel.testnet`, i)); // 40 vaults x 50 refusals
  events.push(ev("honest.keel.testnet", 0));
  const body = reportBody(events as never, 0);
  assert.ok(body.length <= REPORT_MAX_BYTES, `${body.length} bytes`);
  const kept = JSON.parse(body).events as { vault: string }[];
  assert.ok(kept.some((e) => e.vault === "honest.keel.testnet"), "the honest vault's alert is kept");
  const perVault = new Map<string, number>();
  for (const e of kept) perVault.set(e.vault, (perVault.get(e.vault) ?? 0) + 1);
  assert.ok(Math.max(...perVault.values()) <= REPORT_PER_VAULT);
});

test("a normal round's events all go in the report", () => {
  const events = [ev("berth.keel.testnet", 0), ev("deck85369.keel.testnet", 0), ev("deck85369.keel.testnet", 1)];
  assert.equal(JSON.parse(reportBody(events as never, 0)).events.length, 3);
});
