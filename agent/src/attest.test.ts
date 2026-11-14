// Offline tests of the NEAR AI attestation check. No network:
// - fixtures/nearai-attestation.json is a real attestation report NEAR AI published,
// - fixtures/intel-collateral.json is Intel's real collateral for its quote,
//   verified at the moment it was fetched,
// - chat signatures come from a throwaway test key standing in for NEAR AI's.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { checkAttestation, checkSignature, clearAttested, sha256Hex, verifyQuote, type QuoteVerifierFn } from "./attest";
import { review, stricter } from "./review";
import type { Config } from "./chain";

const read = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const fx = read("nearai-attestation.json") as { nonce: string; gateway_attestation: { signing_address: string; signing_algo: string; intel_quote: string; report_data: string } };
const intel = read("intel-collateral.json") as { fetched_at_secs: number; collateral: Record<string, string> };
const real = { gateway_attestation: fx.gateway_attestation };
const realSigner = fx.gateway_attestation.signing_address;
const realQuote = Buffer.from(fx.gateway_attestation.intel_quote, "hex");
const T = intel.fetched_at_secs;

/** Intel's real check, offline: the saved collateral, at the time it was fetched. */
const offlineIntel =
  (collateral = intel.collateral, now = T): QuoteVerifierFn =>
  async (q) =>
    verifyQuote(q, collateral as never, now);

// Throwaway keys for tests only; they hold nothing.
const nearAiKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const otherKey = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

const REPORT_DATA = 48 + 520; // byte offset of report_data in a version 4 TDX quote
const nonceHex = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

/** The real quote with its report_data rewritten: a forgery, since Intel's signature no longer matches. */
function forged(addr: string, nonce: string): string {
  const q = Buffer.from(realQuote);
  Buffer.concat([Buffer.from(addr.slice(2), "hex"), Buffer.alloc(12), Buffer.from(nonce, "hex")]).copy(q, REPORT_DATA);
  return q.toString("hex");
}

beforeEach(() => clearAttested());

test("NEAR AI's real quote verifies up to Intel's root, and binds its signer and Keel's nonce", async () => {
  const proof = verifyQuote(realQuote, intel.collateral as never, T);
  assert.equal(proof.tcb, "UpToDate");
  assert.equal(proof.reportData.toString("hex"), fx.gateway_attestation.report_data);
  assert.deepEqual(await checkAttestation(real, realSigner, fx.nonce, offlineIntel()), { ok: true, signer: realSigner.toLowerCase(), tcb: "UpToDate" });
});

test("a forged, edited or stale quote fails Intel's check", async () => {
  const check = (att: object, signer = realSigner, nonce = fx.nonce, v = offlineIntel()) => checkAttestation({ gateway_attestation: { ...fx.gateway_attestation, ...att } }, signer, nonce, v);
  // A quote rewritten to bind another key: what the light check alone could not catch.
  assert.deepEqual(await check({ signing_address: otherKey.address, intel_quote: forged(otherKey.address, fx.nonce) }, otherKey.address), {
    ok: false,
    reason: "Intel check failed: ISV enclave report signature is invalid",
  });
  // One flipped bit anywhere in the signed part, here the TD's debug attribute.
  const debug = Buffer.from(realQuote);
  debug[48 + 120] |= 1;
  assert.equal((await check({ intel_quote: debug.toString("hex") })).ok, false);
  // A genuine quote, but made for another request's nonce.
  assert.deepEqual(await check({}, realSigner, nonceHex(7)), { ok: false, reason: "TDX quote is not for Keel's nonce" });
  // Intel's collateral edited (a TCB level relabelled), or used after it expired.
  const edited = { ...intel.collateral, tcb_info: intel.collateral.tcb_info.replace("OutOfDate", "UpToDate") };
  assert.equal((await check({}, realSigner, fx.nonce, offlineIntel(edited))).ok, false);
  assert.deepEqual(await check({}, realSigner, fx.nonce, offlineIntel(intel.collateral, T + 40 * 86400)), { ok: false, reason: "Intel check failed: TCBInfo expired" });
  // Missing or junk quotes and reports.
  for (const intel_quote of ["", "zz", fx.gateway_attestation.intel_quote.slice(0, 600)]) assert.equal((await check({ intel_quote })).ok, false, intel_quote.slice(0, 8));
  assert.deepEqual(await checkAttestation(real, nearAiKey.address, fx.nonce, offlineIntel()), { ok: false, reason: "attestation does not name the signer" });
  for (const junk of [null, 1, "x", [], {}]) assert.equal((await checkAttestation(junk, realSigner, fx.nonce, offlineIntel())).ok, false);
  assert.equal((await check({ signing_algo: "ed25519" })).ok, false);
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

// End to end through review(). A test key cannot get a quote Intel signed, so these runs use a
// stand-in for Intel's check that only reads report_data; the tests above run Intel's real check.
const standIn =
  (tcb = "UpToDate"): QuoteVerifierFn =>
  async (q) => ({ reportData: q.subarray(REPORT_DATA, REPORT_DATA + 64), tcb });
const never: QuoteVerifierFn = () => new Promise(() => {});

type Scenario = {
  verdict: "ok" | "propose" | "refuse";
  /** What a man in the middle does to the answer after NEAR AI signed it. */
  tamper?: (raw: string) => string;
  signFor?: "this" | "other-request";
  signer?: typeof nearAiKey;
  sigStatus?: number;
  sigDelayMs?: number;
  report?: "good" | "huge" | "junk" | "stale-nonce";
  verifyQuote?: QuoteVerifierFn;
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
        return res.end(JSON.stringify({ gateway_attestation: { signing_address: nearAiKey.address, signing_algo: "ecdsa", intel_quote: forged(nearAiKey.address, nonce) } }));
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
    const v = await review(cloud.cfg, input, timeoutMs, { verifyQuote: s.verifyQuote ?? standIn() });
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
    ["forged quote, run through Intel's real check", { verdict: "refuse", verifyQuote: offlineIntel() }, "Intel check failed: ISV enclave report signature is invalid"],
    ["enclave platform behind on security patches", { verdict: "refuse", verifyQuote: standIn("OutOfDate") }, "enclave platform TCB is OutOfDate"],
    ["Intel's service never answers", { verdict: "refuse", verifyQuote: never }, "check failed: attestation check timed out"],
    ["signature endpoint down", { verdict: "refuse", sigStatus: 503 }, "check failed: HTTP 503"],
    ["attestation report too large", { verdict: "refuse", report: "huge" }, "check failed: response too large"],
    ["attestation report is junk", { verdict: "refuse", report: "junk" }, "check failed:"],
  ];
  for (const [name, s, why] of cases) {
    const { v, decision } = await run(s, name.startsWith("Intel's service") ? 300 : 2000);
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
