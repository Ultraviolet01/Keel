import { test } from "node:test";
import assert from "node:assert/strict";
import { notable } from "./notify";

const v = "acme.keel.testnet";

test("refusals, a short forecast and vault refusals are reported; routine steps are not", () => {
  assert.equal(notable({ vault: v, step: "decide", text: "refuse, nothing signed: scam pays x, which is on the vault's blocklist" })?.kind, "refused");
  assert.deepEqual(notable({ vault: v, step: "forecast", text: "short 12.00 USDC on 2026-11-12" }), {
    vault: v,
    kind: "short",
    text: "The forecast is short 12.00 USDC on 2026-11-12.",
    key: `${v}:short:2026-11-12`,
  });
  assert.equal(notable({ vault: v, step: "act", text: "the vault refused: Keel Vault refused: over the daily cap" })?.kind, "vault_refused");
  assert.equal(notable({ vault: v, step: "forecast", text: "covered for the next 3 days (ends at 4.00 USDC)" }), null);
  assert.equal(notable({ vault: v, step: "decide", text: "pay alone: approved payee" }), null);
});

test("a shortfall keeps one key while the date stays, whatever the amount", () => {
  const a = notable({ vault: v, step: "forecast", text: "short 12.00 USDC on 2026-11-12" })!;
  const b = notable({ vault: v, step: "forecast", text: "short 9.50 USDC on 2026-11-12" })!;
  assert.equal(a.key, b.key);
});
