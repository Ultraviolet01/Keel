// Offline tests of the NEAR AI attestation check. No network:
// - fixtures/nearai-attestation.json is a real gateway attestation NEAR AI published
//   (quote, event log and app_compose), fetched with a nonce Keel generated,
// - fixtures/intel-collateral.json is Intel's real collateral for its quote,
//   verified at the moment it was fetched,
// - response signatures come from a throwaway test key standing in for NEAR AI's gateway.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { checkGatewayReport, checkResponseSignature, clearAttested, replayRtmr3, sha256Hex, verifyQuote, type QuoteVerifierFn } from "./attest";
import { review, stricter } from "./review";
import type { Config } from "./chain";

type Att = { signing_address: string; signing_algo: string; intel_quote: string; report_data: string; request_nonce: string; event_log: string; info: { tcb_info: { app_compose: string } } };
const read = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const fx = read("nearai-attestation.json") as { nonce: string; gateway_attestation: Att };
const intel = read("intel-collateral.json") as { fetched_at_secs: number; collateral: Record<string, string> };
const ga = fx.gateway_attestation;
const realQuote = Buffer.from(ga.intel_quote, "hex");
const T = intel.fetched_at_secs;

/** Intel's real check, offline: the saved collateral, at the time it was fetched. */
const offlineIntel =
  (collateral = intel.collateral, now = T): QuoteVerifierFn =>
  async (q) =>
    verifyQuote(q, collateral as never, now);

// Throwaway keys for tests only; they hold nothing.
const gatewayKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const otherKey = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

// Byte offsets in a version 4 TDX quote (48-byte header, then the TD report).
const TD = 48;
const nonceHex = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

/** The real quote with its report_data rewritten: a forgery, since Intel's signature no longer matches. */
function forged(addr: string, nonce: string): string {
  const q = Buffer.from(realQuote);
  Buffer.concat([Buffer.from(addr.slice(2), "hex"), Buffer.alloc(12), Buffer.from(nonce, "hex")]).copy(q, TD + 520);
  return q.toString("hex");
}

beforeEach(() => clearAttested());

test("NEAR AI's real gateway report passes every documented check", async () => {
  const q = verifyQuote(realQuote, intel.collateral as never, T);
  assert.equal(q.tcb, "UpToDate");
  assert.equal(q.debug, false);
  assert.equal(q.reportData.toString("hex"), ga.report_data);
  assert.ok(replayRtmr3(ga.event_log).equals(q.rtMr3));
  assert.deepEqual(await checkGatewayReport(ga, fx.nonce, offlineIntel()), { ok: true, signer: ga.signing_address.toLowerCase(), tcb: "UpToDate" });
});

test("each documented gateway check refuses what it should", async () => {
  const check = (att: Partial<Att> & Record<string, unknown>, nonce = fx.nonce, v = offlineIntel()) => checkGatewayReport({ ...ga, ...att }, nonce, v);
  const no = async (att: Partial<Att> & Record<string, unknown>, reason: string, nonce?: string, v?: QuoteVerifierFn) => assert.deepEqual(await check(att, nonce, v), { ok: false, reason });

  // The echoed nonce, and a genuine quote made for another nonce.
  await no({ request_nonce: nonceHex(7) }, "echoed nonce is not Keel's");
  await no({ request_nonce: nonceHex(7) }, "TDX quote is not for Keel's nonce", nonceHex(7));
  // A quote rewritten to bind another key, and one flipped bit (the TD's debug attribute).
  await no({ signing_address: otherKey.address, intel_quote: forged(otherKey.address, fx.nonce) }, "Intel check failed: ISV enclave report signature is invalid");
  const debug = Buffer.from(realQuote);
  debug[TD + 120] |= 1;
  assert.equal((await check({ intel_quote: debug.toString("hex") })).ok, false);
  // HTTP copies that differ from the verified quote.
  await no({ report_data: "00" + ga.report_data.slice(2) }, "echoed report data differs from the quote");
  // The configuration and the event log.
  await no({ info: { tcb_info: { app_compose: ga.info.tcb_info.app_compose + " " } } }, "MRCONFIGID does not match app_compose");
  // tcb_info may come as JSON text; it is decoded, not rejected.
  assert.equal((await check({ info: { tcb_info: JSON.stringify({ app_compose: ga.info.tcb_info.app_compose }) } as never })).ok, true);
  await no({ info: {} as never }, "attestation has no app_compose");
  const events = JSON.parse(ga.event_log) as { imr: number; event: string; event_payload: string; digest: string }[];
  const last3 = events.map((e) => e.imr).lastIndexOf(3);
  const edited = events.map((e, i) => (i === last3 ? { ...e, event_payload: e.event_payload + "00", digest: "" } : e));
  await no({ event_log: JSON.stringify(edited) }, "event log does not match RTMR3");
  // NEAR AI's events carry empty digests (allowed by the docs); one that states a wrong digest is refused.
  const lying = events.map((e, i) => (i === last3 ? { ...e, digest: "00".repeat(48) } : e));
  const r = await check({ event_log: JSON.stringify(lying) });
  assert.ok(!r.ok && /^measurements unreadable: event .* does not match its digest/.test(r.reason));
  await no({ event_log: JSON.stringify(events.filter((e) => e.imr !== 3)) }, "event log does not match RTMR3");
  // Keel's TCB policy, and Intel's collateral edited or expired.
  const swHardening: QuoteVerifierFn = async (q) => ({ ...(await offlineIntel()(q)), tcb: "SWHardeningNeeded" });
  await no({}, "enclave platform TCB is SWHardeningNeeded", fx.nonce, swHardening);
  assert.equal((await check({}, fx.nonce, offlineIntel({ ...intel.collateral, tcb_info: intel.collateral.tcb_info.replace("OutOfDate", "UpToDate") }))).ok, false);
  await no({}, "Intel check failed: TCBInfo expired", fx.nonce, offlineIntel(intel.collateral, T + 40 * 86400));
  // Junk.
  await no({ signing_algo: "ed25519" }, "gateway attestation is not for ecdsa");
  await no({ signing_address: "near.testnet" }, "gateway signer malformed");
  for (const intel_quote of ["", "zz", ga.intel_quote.slice(0, 600)]) assert.equal((await check({ intel_quote })).ok, false);
  for (const junk of [null, 1, "x", []]) assert.equal((await checkGatewayReport(junk, fx.nonce, offlineIntel())).ok, false);
});

const request = '{"model":"m","messages":[{"role":"user","content":"bill A"}]}';
const response = '{"id":"chat-1","choices":[{"message":{"content":"{\\"verdict\\":\\"propose\\",\\"reason\\":\\"lookalike\\"}"}}]}';
const signed = async (req = request, res = response, key = gatewayKey, extra: Record<string, unknown> = {}) => {
  const text = `${sha256Hex(req)}:${sha256Hex(res)}`;
  return { signature_kind: "gateway", signing_algo: "ecdsa", text, signature: await key.signMessage({ message: text }), signing_address: key.address, ...extra };
};

test("a response signature counts only as a gateway signature over these exact bytes, by the preflight signer", async () => {
  const pre = gatewayKey.address;
  const no = async (sig: unknown, reason: string, req = request, res = response) => assert.deepEqual(await checkResponseSignature(req, res, sig, pre), { ok: false, reason });
  assert.deepEqual(await checkResponseSignature(request, response, await signed(), pre), { ok: true, signer: pre.toLowerCase() });
  await no(await signed(request, response.replace("propose", "ok")), "response changed after it was signed");
  await no(await signed(), "response changed after it was signed", request, response.replace("propose", "ok"));
  await no(await signed(), "signed request is not the one Keel sent", request.replace("bill A", "bill B"));
  // The gateway's key changed since Keel verified it: a valid signature, but not by the attested signer.
  await no(await signed(request, response, otherKey), "signer is not the gateway Keel verified before asking");
  const s = await signed(request, response, otherKey);
  await no({ ...s, signing_address: gatewayKey.address }, "signed by another key than the one named");
  // signature_kind decides the expected text; an unknown or missing kind is not guessed from the text.
  await no(await signed(request, response, gatewayKey, { signature_kind: "provider_tee" }), "signature kind provider_tee is not one Keel accepts");
  await no(await signed(request, response, gatewayKey, { signature_kind: undefined }), "signature kind missing is not one Keel accepts");
  const ok = await signed();
  await no({ ...ok, text: `m:${ok.text}` }, "signature text is not request_hash:response_hash");
  await no({ error_code: "stream_disconnected", message: "unavailable" }, "signature unavailable: stream_disconnected");
  await no({ ...ok, signing_algo: "ed25519" }, "signature is not ecdsa");
  for (const bad of [null, "x", { ...ok, signature: "0x12" }, { ...ok, signing_address: "near.testnet" }, { ...ok, text: "x".repeat(400) }]) {
    assert.equal((await checkResponseSignature(request, response, bad, pre)).ok, false);
  }
});

// End to end through review(). A test key cannot get a quote Intel signed, so these runs use a
// stand-in for Intel's check that reads the quote's fields unverified; the tests above run Intel's real check.
const standIn =
  (tcb = "UpToDate"): QuoteVerifierFn =>
  async (q) => ({ reportData: q.subarray(TD + 520, TD + 584), mrConfigId: q.subarray(TD + 184, TD + 232), rtMr3: q.subarray(TD + 472, TD + 520), debug: (q[TD + 120] & 1) === 1, tcb });
const never: QuoteVerifierFn = () => new Promise(() => {});

type Scenario = {
  verdict: "ok" | "propose" | "refuse";
  /** What a man in the middle does to the answer after the gateway signed it. */
  tamper?: (raw: string) => string;
  signFor?: "this" | "other-request";
  signer?: typeof gatewayKey;
  sigExtra?: Record<string, unknown>;
  sigStatus?: number;
  sigNotFound?: number; // 404s before the signature is recorded
  sigDelayMs?: number;
  report?: "good" | "huge" | "junk" | "stale-nonce";
  verifyQuote?: QuoteVerifierFn;
};

/** A local stand-in for NEAR AI Cloud: attestation report, chat and signature. Records the order of calls. */
async function fakeCloud(s: Scenario) {
  let lastRequest = "";
  let lastResponse = "";
  let notFound = s.sigNotFound ?? 0;
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname.endsWith("/attestation/report")) {
        calls.push("report");
        if (s.report === "huge") return res.end(JSON.stringify({ pad: "x".repeat(1_200_000) }));
        if (s.report === "junk") return res.end("<html>not json");
        const nonce = s.report === "stale-nonce" ? fx.nonce : (url.searchParams.get("nonce") ?? "");
        return res.end(JSON.stringify({ gateway_attestation: { ...ga, report_data: undefined, signing_address: gatewayKey.address, request_nonce: url.searchParams.get("nonce"), intel_quote: forged(gatewayKey.address, nonce) } }));
      }
      if (url.pathname.endsWith("/chat/completions")) {
        calls.push("chat");
        lastRequest = raw;
        lastResponse = JSON.stringify({ id: "chat-1", choices: [{ message: { content: JSON.stringify({ verdict: s.verdict, reason: "the payee looks like Northwind but is not" }) } }] });
        return res.end(s.tamper ? s.tamper(lastResponse) : lastResponse);
      }
      if (url.pathname.includes("/signature/")) {
        calls.push("signature");
        if (s.sigStatus) return res.writeHead(s.sigStatus).end("{}");
        if (notFound-- > 0) return res.writeHead(404).end("{}");
        const body = JSON.stringify(await signed(s.signFor === "other-request" ? lastRequest.replace("Northwind", "Southwind") : lastRequest, lastResponse, s.signer ?? gatewayKey, s.sigExtra));
        return setTimeout(() => res.end(body), s.sigDelayMs ?? 0);
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const cfg = { nearAiKey: "test", nearAiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, nearAiModel: "m", anthropicModel: "x" } as Config;
  return { cfg, calls, close: () => server.close() };
}

const input = { company: "acme", payee: "northwlnd-keel.testnet", payeeName: "Northwind", amount: "2.00 USDC", due: "2026-11-26", history: [], knownPayees: ["Northwind Hosting (northwind-keel.testnet)"] };
const pay = { kind: "pay" as const, reason: "allowlisted payee within the per-payment and daily caps" };

async function run(s: Scenario, timeoutMs = 2000, rounds = 1) {
  clearAttested(); // each case starts without preflight evidence
  const cloud = await fakeCloud(s);
  try {
    let v = null;
    for (let i = 0; i < rounds; i++) v = await review(cloud.cfg, input, timeoutMs, { verifyQuote: s.verifyQuote ?? standIn(), retryMs: 20 });
    return { v, decision: stricter(pay, v), calls: cloud.calls };
  } finally {
    cloud.close();
  }
}

test("the gateway is verified before Keel asks, and that evidence is reused for 10 minutes", async () => {
  const { v, decision, calls } = await run({ verdict: "refuse" }, 2000, 2);
  assert.equal(v?.attested, true);
  assert.equal(decision.kind, "refuse");
  assert.deepEqual(calls, ["report", "chat", "signature", "chat", "signature"]);
});

test("a signature not recorded yet is retried briefly", async () => {
  assert.equal((await run({ verdict: "refuse", sigNotFound: 2 })).v?.attested, true);
  const { v, decision } = await run({ verdict: "refuse", sigNotFound: 5 });
  assert.equal(v?.check, "signature not found");
  assert.equal(decision.kind, "propose");
});

test("attacks on the answer never make Keel pay more than its rules allow", async () => {
  const cases: [string, Scenario, string][] = [
    ["verdict edited after signing (refuse to ok)", { verdict: "refuse", tamper: (r) => r.replace("refuse", "ok") }, "response changed after it was signed"],
    ["signed by a key other than the attested gateway", { verdict: "refuse", signer: otherKey }, "signer is not the gateway Keel verified before asking"],
    ["old signature replayed for another request", { verdict: "refuse", signFor: "other-request" }, "signed request is not the one Keel sent"],
    ["signature of an unknown kind", { verdict: "refuse", sigExtra: { signature_kind: "provider_tee" } }, "signature kind provider_tee is not one Keel accepts"],
    ["signature unavailable", { verdict: "refuse", sigExtra: { error_code: "stream_disconnected" } }, "signature unavailable: stream_disconnected"],
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
    assert.equal(v?.attested, false, `${name}: ${v?.check}`);
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
