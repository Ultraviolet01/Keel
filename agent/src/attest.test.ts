// Offline tests of the NEAR AI attestation check. No network: the attestation
// report is a real one NEAR AI published (fixtures/nearai-attestation.json),
// and the signatures come from a throwaway test key standing in for NEAR AI's.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { checkAttestation, checkSignature, clearAttested, readQuote, sha256Hex } from "./attest";
import { review, stricter } from "./review";
import type { Config } from "./chain";

const fx = JSON.parse(readFileSync(new URL("./fixtures/nearai-attestation.json", import.meta.url), "utf8")) as {
  nonce: string;
  gateway_attestation: { signing_address: string; signing_algo: string; intel_quote: string; report_data: string };
};
const real = { gateway_attestation: fx.gateway_attestation };
const realSigner = fx.gateway_attestation.signing_address;

// Throwaway keys for tests only; they hold nothing.
const nearAiKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const otherKey = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

const REPORT_DATA = 48 + 520; // byte offset in a version 4 TDX quote
const nonceHex = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

/** The real quote with its report_data rewritten. Shows what the light check cannot catch: Intel's signature is not checked. */
function quoteFor(addr: string, nonce: string, debug = false): string {
  const q = Buffer.from(fx.gateway_attestation.intel_quote, "hex");
  Buffer.concat([Buffer.from(addr.slice(2), "hex"), Buffer.alloc(12), Buffer.from(nonce, "hex")]).copy(q, REPORT_DATA);
  if (debug) q[48 + 120] |= 1;
  return q.toString("hex");
}

beforeEach(() => clearAttested());

test("the real NEAR AI quote binds its signer and Keel's nonce", () => {
  const q = readQuote(fx.gateway_attestation.intel_quote);
  assert.ok(q);
  assert.equal(q.reportData.toString("hex"), fx.gateway_attestation.report_data);
  assert.equal(q.debug, false);
  assert.deepEqual(checkAttestation(real, realSigner, fx.nonce), { ok: true, signer: realSigner.toLowerCase() });
});

test("an attestation for another nonce, another signer, a debug enclave or junk is refused", () => {
  assert.deepEqual(checkAttestation(real, realSigner, nonceHex(7)), { ok: false, reason: "TDX quote is not for Keel's nonce" });
  assert.deepEqual(checkAttestation(real, nearAiKey.address, fx.nonce), { ok: false, reason: "attestation does not name the signer" });
  const debug = { gateway_attestation: { ...fx.gateway_attestation, intel_quote: quoteFor(realSigner, fx.nonce, true) } };
  assert.deepEqual(checkAttestation(debug, realSigner, fx.nonce), { ok: false, reason: "attestation is from a debug enclave" });
  // The report names the signer, but the quote inside binds someone else.
  const swapped = { gateway_attestation: { ...fx.gateway_attestation, intel_quote: quoteFor(otherKey.address, fx.nonce) } };
  assert.deepEqual(checkAttestation(swapped, realSigner, fx.nonce), { ok: false, reason: "TDX quote does not bind the signer" });
  for (const intel_quote of ["", "zz", fx.gateway_attestation.intel_quote.slice(0, 600), "05" + fx.gateway_attestation.intel_quote.slice(2)]) {
    const r = checkAttestation({ gateway_attestation: { ...fx.gateway_attestation, intel_quote } }, realSigner, fx.nonce);
    assert.equal(r.ok, false, intel_quote.slice(0, 10));
  }
  for (const junk of [null, 1, "x", [], {}, { gateway_attestation: { signing_address: realSigner, signing_algo: "ed25519", intel_quote: fx.gateway_attestation.intel_quote } }]) {
    assert.equal(checkAttestation(junk, realSigner, fx.nonce).ok, false);
  }
});

const request = '{"model":"m","messages":[{"role":"user","content":"bill A"}]}';
const response = '{"id":"chat-1","choices":[{"message":{"content":"{\\"verdict\\":\\"propose\\",\\"reason\\":\\"lookalike\\"}"}}]}';
const signed = async (req = request, res = response, key = nearAiKey, prefix = "") => {
  const text = `${prefix}${sha256Hex(req)}:${sha256Hex(res)}`;
  return { text, signature: await key.signMessage({ message: text }), signing_address: key.address };
};

test("a signature counts only for this request, this response and its own key", async () => {
  assert.deepEqual(await checkSignature(request, response, await signed()), { ok: true, signer: nearAiKey.address.toLowerCase() });
  assert.equal((await checkSignature(request, response, await signed(request, response, nearAiKey, "chat-1:"))).ok, true);
  // The verdict edited after signing.
  assert.deepEqual(await checkSignature(request, response.replace("propose", "ok"), await signed()), { ok: false, reason: "response changed after it was signed" });
  // An old, validly signed answer replayed for another bill.
  assert.deepEqual(await checkSignature(request.replace("bill A", "bill B"), response, await signed()), { ok: false, reason: "signed request is not the one Keel sent" });
  // Signed by one key, claiming another.
  const s = await signed(request, response, otherKey);
  assert.deepEqual(await checkSignature(request, response, { ...s, signing_address: nearAiKey.address }), { ok: false, reason: "signed by another key than the one named" });
  for (const bad of [null, "x", {}, { ...s, text: "abc" }, { ...s, text: `a:b:${s.text}` }, { ...s, signature: "0x12" }, { ...s, signing_address: "near.testnet" }, { ...s, text: "x".repeat(400) }]) {
    assert.equal((await checkSignature(request, response, bad)).ok, false);
  }
});

type Scenario = {
  verdict: "ok" | "propose" | "refuse";
  /** What a man in the middle does to the answer after NEAR AI signed it. */
  tamper?: (raw: string) => string;
  signFor?: "this" | "other-request";
  signer?: typeof nearAiKey;
  /** Whose address the attestation's quote binds. */
  attested?: typeof nearAiKey;
  sigStatus?: number;
  sigDelayMs?: number;
  report?: "good" | "huge" | "junk" | "stale-nonce";
};

/** A local stand-in for NEAR AI Cloud: chat, signature and attestation report. */
async function fakeCloud(s: Scenario) {
  let lastRequest = "";
  let lastResponse = "";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname.endsWith("/chat/completions")) {
        lastRequest = raw;
        lastResponse = JSON.stringify({ id: "chat-1", choices: [{ message: { content: JSON.stringify({ verdict: s.verdict, reason: "the payee looks like Northwind but is not" }) } }] });
        return res.end(s.tamper ? s.tamper(lastResponse) : lastResponse);
      }
      if (url.pathname.includes("/signature/")) {
        if (s.sigStatus) return res.writeHead(s.sigStatus).end("{}");
        const body = JSON.stringify(await signed(s.signFor === "other-request" ? lastRequest.replace("Northwind", "Southwind") : lastRequest, lastResponse, s.signer ?? nearAiKey));
        return setTimeout(() => res.end(body), s.sigDelayMs ?? 0);
      }
      if (url.pathname.endsWith("/attestation/report")) {
        if (s.report === "huge") return res.end(JSON.stringify({ pad: "x".repeat(1_200_000) }));
        if (s.report === "junk") return res.end("<html>not json");
        const nonce = s.report === "stale-nonce" ? fx.nonce : (url.searchParams.get("nonce") ?? "");
        const who = s.attested ?? nearAiKey;
        return res.end(JSON.stringify({ gateway_attestation: { signing_address: who.address, signing_algo: "ecdsa", intel_quote: quoteFor(who.address, nonce) } }));
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const cfg = { nearAiKey: "test", nearAiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, nearAiModel: "m", anthropicModel: "x" } as Config;
  return { cfg, close: () => server.close() };
}

const input = { company: "acme", payee: "northwlnd-keel.testnet", payeeName: "Northwind", amount: "2.00 USDC", due: "2026-11-26", history: [], knownPayees: ["Northwind Hosting (northwind-keel.testnet)"] };
const pay = { kind: "pay" as const, reason: "allowlisted payee within the per-payment and daily caps" };

async function run(s: Scenario, timeoutMs = 2000) {
  const cloud = await fakeCloud(s);
  try {
    const v = await review(cloud.cfg, input, timeoutMs);
    return { v, decision: stricter(pay, v) };
  } finally {
    cloud.close();
  }
}

test("a signed, attested refusal is followed: nothing is paid", async () => {
  const { v, decision } = await run({ verdict: "refuse" });
  assert.equal(v?.attested, true);
  assert.equal(decision.kind, "refuse");
});

test("attacks on the answer never make Keel pay more than its rules allow", async () => {
  const cases: [string, Scenario, string][] = [
    ["verdict edited after signing (refuse to ok)", { verdict: "refuse", tamper: (r) => r.replace("refuse", "ok") }, "response changed after it was signed"],
    ["forged refusal, signed by a key the attestation does not name", { verdict: "refuse", signer: otherKey }, "attestation does not name the signer"],
    ["old signature replayed for another request", { verdict: "refuse", signFor: "other-request" }, "signed request is not the one Keel sent"],
    ["attestation quote for an old nonce", { verdict: "refuse", report: "stale-nonce" }, "TDX quote is not for Keel's nonce"],
    ["signature endpoint down", { verdict: "refuse", sigStatus: 503 }, "check failed: HTTP 503"],
    ["attestation report too large", { verdict: "refuse", report: "huge" }, "check failed: response too large"],
    ["attestation report is junk", { verdict: "refuse", report: "junk" }, "check failed:"],
  ];
  for (const [name, s, why] of cases) {
    const { v, decision } = await run(s);
    assert.equal(v?.attested, false, name);
    assert.ok(v?.check?.startsWith(why), `${name}: ${v?.check}`);
    if (v?.verdict === "ok") assert.deepEqual(decision, pay, name); // same as no review: the vault's rules decide
    else assert.equal(decision.kind, "propose", name); // an unproven refusal goes to the owner, never straight to refuse
  }
});

test("a slow signature endpoint is given up within the timeout and the round goes on", async () => {
  const started = Date.now();
  const { v, decision } = await run({ verdict: "propose", sigDelayMs: 1500 }, 300);
  assert.ok(Date.now() - started < 1400);
  assert.equal(v?.attested, false);
  assert.match(v?.check ?? "", /^check failed/);
  assert.equal(decision.kind, "propose");
});
