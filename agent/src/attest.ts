// Checks a NEAR AI Cloud answer the way NEAR AI's verification docs set out
// (docs.near.ai/cloud/verification: gateway attestation, response signatures,
// quote/nonce/signer bindings, verification policy):
//
// Before the completion (preflight), Keel verifies the gateway's attestation:
//   - GET /v1/attestation/report with a nonce Keel generated (32 random bytes),
//   - the Intel TDX quote verified against Intel's collateral up to Intel's
//     SGX root CA, pinned below (Phala's dcap-qvl, the verifier NEAR AI names),
//     TCB status UpToDate, no debug enclave,
//   - from the verified quote: report_data = signer (zero-padded) || nonce,
//     MRCONFIGID = 01 || sha256(app_compose) || 15 zero bytes, and RTMR3 equal
//     to the replayed event log; the echoed request_nonce and report_data match.
// The verified signer is kept as evidence for at most 10 minutes.
//
// After the completion, Keel fetches the response signature and requires a
// `gateway` signature whose text is exactly sha256(request):sha256(response)
// over the bytes sent and received, recovering (EIP-191) to the preflight signer.
//
// What this does not establish: which model produced the answer. A gateway
// signature binds the answer to NEAR AI's attested gateway, not to a model
// enclave, and Keel keeps no list of accepted gateway builds (image provenance).
// Nothing here throws: every failure is { ok: false, reason }.

import { createHash, randomBytes } from "node:crypto";
import { INTEL_PCS_URL, QuoteVerifier, getCollateral, isBrowser, type Collateral, type TDReport10, type TDReport15, type TDReport15Ex } from "@phala/dcap-qvl";
import { recoverMessageAddress, type Hex } from "viem";

/** `tampered`: the answer came with a signature that does not match it, which is evidence of tampering, not an outage. */
export type Check = { ok: true; signer: string; tcb?: string } | { ok: false; reason: string; tampered?: true };

const MAX_BODY = 1_000_000; // the real report is about 180 kB
const HEX = /^[0-9a-f]*$/i;
const EVIDENCE_FOR_MS = 10 * 60_000; // maximum age of preflight evidence

/** SHA-256 of exact bytes (a string is taken as its UTF-8 bytes). */
export const sha256Hex = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

const fail = (reason: string): Check => ({ ok: false, reason });
const tampered = (reason: string): Check => ({ ok: false, reason, tampered: true });
/** Server-supplied text, safe to put in a reason or a log line. */
const clean = (v: unknown, max = 40) => (typeof v === "string" || typeof v === "number" ? String(v) : typeof v).replace(/[^\x20-\x7e]/g, "?").slice(0, max);

// Intel SGX Root CA, as published at
// certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.cer.
// Pinned here so a changed dependency cannot change whom Keel trusts.
const INTEL_ROOT_CA = Buffer.from(
  "MIICjzCCAjSgAwIBAgIUImUM1lqdNInzg7SVUr9QGzknBqwwCgYIKoZIzj0EAwIwaDEaMBgGA1UEAwwRSW50ZWwgU0dYIFJvb3Qg" +
    "Q0ExGjAYBgNVBAoMEUludGVsIENvcnBvcmF0aW9uMRQwEgYDVQQHDAtTYW50YSBDbGFyYTELMAkGA1UECAwCQ0ExCzAJBgNVBAYT" +
    "AlVTMB4XDTE4MDUyMTEwNDUxMFoXDTQ5MTIzMTIzNTk1OVowaDEaMBgGA1UEAwwRSW50ZWwgU0dYIFJvb3QgQ0ExGjAYBgNVBAoM" +
    "EUludGVsIENvcnBvcmF0aW9uMRQwEgYDVQQHDAtTYW50YSBDbGFyYTELMAkGA1UECAwCQ0ExCzAJBgNVBAYTAlVTMFkwEwYHKoZI" +
    "zj0CAQYIKoZIzj0DAQcDQgAEC6nEwMDIYZOj/iPWsCzaEKi71OiOSLRFhWGjbnBVJfVnkY4u3IjkDYYL0MxO4mqsyYjlBalTVYxF" +
    "P2sJBK5zlKOBuzCBuDAfBgNVHSMEGDAWgBQiZQzWWp00ifODtJVSv1AbOScGrDBSBgNVHR8ESzBJMEegRaBDhkFodHRwczovL2Nl" +
    "cnRpZmljYXRlcy50cnVzdGVkc2VydmljZXMuaW50ZWwuY29tL0ludGVsU0dYUm9vdENBLmRlcjAdBgNVHQ4EFgQUImUM1lqdNInz" +
    "g7SVUr9QGzknBqwwDgYDVR0PAQH/BAQDAgEGMBIGA1UdEwEB/wQIMAYBAf8CAQEwCgYIKoZIzj0EAwIDSQAwRgIhAOW/5QkR+S9C" +
    "iSDcNoowLuPRLsWGf/Yi7GSX94BgwTwgAiEA4J0lrHoMs+Xo5o/sX6O9QWxHRAvZUGOdRQ7cvqRXaqI=",
  "base64",
);
export const INTEL_ROOT_SHA256 = "44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3";

/** Keel's TCB policy, as in NEAR AI's example: only a fully patched platform counts. */
const GOOD_TCB = new Set(["UpToDate"]);

/** What a verified quote proves, read from the quote Intel's chain verified. */
export type QuoteProof = { reportData: Buffer; mrConfigId: Buffer; rtMr3: Buffer; debug: boolean; tcb: string };
/** Verifies a TDX quote or throws. */
export type QuoteVerifierFn = (quote: Buffer) => Promise<QuoteProof>;

/** Verifies a quote against given collateral at a given time, up to the pinned Intel root. Throws on failure. */
export function verifyQuote(quote: Buffer, collateral: Collateral, nowSecs: number): QuoteProof {
  if (createHash("sha256").update(INTEL_ROOT_CA).digest("hex") !== INTEL_ROOT_SHA256) throw new Error("pinned Intel root CA changed");
  // In Node, dcap-qvl verifies with Node's own crypto; its pure-JS path uses elliptic (advisory GHSA-848j-6mx2-7j84).
  if (isBrowser) throw new Error("dcap-qvl would use its pure-JS crypto path");
  const r = new QuoteVerifier(INTEL_ROOT_CA).verify(quote, collateral, nowSecs); // debug enclaves are refused by default
  const d = r.report.data;
  // TD 1.0 holds the measurements itself; TD 1.5 nests the 1.0 report as `base`, and 1.5ex nests 1.5.
  const td = r.report.type === "td10" ? (d as TDReport10) : r.report.type === "td15" ? (d as TDReport15).base : r.report.type === "td15ex" ? (d as TDReport15Ex).base.base : null;
  if (!td) throw new Error("not a TDX quote");
  return {
    reportData: Buffer.from(td.reportData),
    mrConfigId: Buffer.from(td.mrConfigId),
    rtMr3: Buffer.from(td.rtMr3),
    debug: (td.tdAttributes[0] & 1) === 1,
    tcb: r.status,
  };
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** The live verifier: fetches the quote's collateral from Intel's PCS, then verifies. */
export const intelVerifier =
  (timeoutMs: number): QuoteVerifierFn =>
  async (quote) => {
    const collateral = await within(getCollateral(INTEL_PCS_URL, quote), timeoutMs, "Intel collateral");
    return verifyQuote(quote, collateral, Math.floor(Date.now() / 1000));
  };

const asJson = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);

/** Replays the RTMR3 events of a dstack event log (NEAR AI docs, "Replay the RTMR3 event log"). Throws on a bad event. */
export function replayRtmr3(eventLog: unknown): Buffer {
  const events = asJson(eventLog);
  if (!Array.isArray(events)) throw new Error("event log is not a list");
  let rtmr3 = Buffer.alloc(48);
  for (const e of events as Record<string, unknown>[]) {
    if (e?.imr !== 3) continue;
    if (!Number.isInteger(e.event_type) || (e.event_type as number) < 0 || (e.event_type as number) > 0xffffffff || typeof e.event !== "string") throw new Error("malformed event");
    const payload = typeof e.event_payload === "string" ? e.event_payload : "";
    if (!HEX.test(payload) || payload.length % 2) throw new Error("malformed event payload");
    const type = Buffer.alloc(4);
    type.writeUInt32LE(e.event_type as number);
    const digest = createHash("sha384").update(Buffer.concat([type, Buffer.from(":"), Buffer.from(e.event, "utf8"), Buffer.from(":"), Buffer.from(payload, "hex")])).digest();
    if (typeof e.digest === "string" && e.digest && e.digest.toLowerCase() !== digest.toString("hex")) throw new Error(`event ${e.event} does not match its digest`);
    rtmr3 = createHash("sha384").update(Buffer.concat([rtmr3, digest])).digest();
  }
  return rtmr3;
}

/** Checks a gateway_attestation against Keel's nonce. The quote is the source of truth; HTTP fields are only compared with it. */
export async function checkGatewayReport(att: unknown, nonce: string, verify: QuoteVerifierFn): Promise<Check> {
  if (!att || typeof att !== "object") return fail("no gateway attestation");
  const a = att as Record<string, unknown>;
  if (a.signing_algo !== "ecdsa") return fail("gateway attestation is not for ecdsa");
  const signer = a.signing_address;
  if (typeof signer !== "string" || !/^0x[0-9a-f]{40}$/i.test(signer)) return fail("gateway signer malformed");
  if (typeof a.request_nonce !== "string" || a.request_nonce.toLowerCase() !== nonce) return fail("echoed nonce is not Keel's");
  const hex = a.intel_quote;
  if (typeof hex !== "string" || !hex || hex.length % 2 || !HEX.test(hex)) return fail("attestation has no TDX quote");
  let q: QuoteProof;
  try {
    q = await verify(Buffer.from(hex, "hex"));
  } catch (e) {
    return fail(`Intel check failed: ${clean(e instanceof Error ? e.message : "unknown error", 100)}`);
  }
  if (!GOOD_TCB.has(q.tcb)) return fail(`enclave platform TCB is ${q.tcb}`);
  if (q.debug) return fail("attestation is from a debug enclave");
  // report_data = signer zero-padded to 32 bytes, then the nonce (no TLS binding requested).
  const expected = Buffer.concat([Buffer.from(signer.slice(2), "hex"), Buffer.alloc(12), Buffer.from(nonce, "hex")]);
  if (q.reportData.length !== 64 || !q.reportData.subarray(0, 32).equals(expected.subarray(0, 32))) return fail("TDX quote does not bind the signer");
  if (!q.reportData.subarray(32).equals(expected.subarray(32))) return fail("TDX quote is not for Keel's nonce");
  if (typeof a.report_data !== "string" || a.report_data.toLowerCase().replace(/^0x/, "") !== q.reportData.toString("hex")) return fail("echoed report data missing or differs from the quote");
  try {
    const info = asJson(a.info) as { tcb_info?: unknown } | undefined;
    const appCompose = (asJson(info?.tcb_info) as { app_compose?: unknown } | undefined)?.app_compose;
    if (typeof appCompose !== "string") return fail("attestation has no app_compose");
    const config = Buffer.concat([Buffer.from([1]), createHash("sha256").update(appCompose, "utf8").digest(), Buffer.alloc(15)]);
    if (!q.mrConfigId.equals(config)) return fail("MRCONFIGID does not match app_compose");
    if (!replayRtmr3(a.event_log).equals(q.rtMr3)) return fail("event log does not match RTMR3");
  } catch (e) {
    return fail(`measurements unreadable: ${clean(e instanceof Error ? e.message : "unknown error", 100)}`);
  }
  return { ok: true, signer: signer.toLowerCase(), tcb: q.tcb };
}

/** After the completion: a `gateway` signature over exactly these bytes, by the preflight signer. */
export async function checkResponseSignature(requestBody: string | Uint8Array, responseBody: string | Uint8Array, sig: unknown, preflightSigner: string): Promise<Check> {
  if (!sig || typeof sig !== "object") return fail("no signature");
  const s = sig as Record<string, unknown>;
  if (s.error_code !== undefined) return fail(`signature unavailable: ${clean(s.error_code)}`);
  if (s.signature_kind !== "gateway") return fail(`signature kind ${s.signature_kind === undefined ? "missing" : clean(s.signature_kind, 30)} is not one Keel accepts`);
  if (s.signing_algo !== "ecdsa") return fail("signature is not ecdsa");
  const { text, signature, signing_address } = s;
  if (typeof text !== "string" || text.length > 300) return fail("signature text missing or malformed");
  if (typeof signature !== "string" || !/^0x[0-9a-f]{130}$/i.test(signature)) return fail("signature malformed");
  if (typeof signing_address !== "string" || !/^0x[0-9a-f]{40}$/i.test(signing_address)) return fail("signer malformed");
  const reqHash = sha256Hex(requestBody);
  const resHash = sha256Hex(responseBody);
  if (text !== `${reqHash}:${resHash}`) {
    const parts = text.split(":");
    if (parts.length !== 2) return fail("signature text is not request_hash:response_hash");
    if (parts[0] !== reqHash) return tampered("signed request is not the one Keel sent");
    return tampered("response changed after it was signed");
  }
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message: text, signature: signature as Hex });
  } catch {
    return tampered("signature does not recover");
  }
  if (recovered.toLowerCase() !== signing_address.toLowerCase()) return tampered("signed by another key than the one named");
  if (recovered.toLowerCase() !== preflightSigner.toLowerCase()) return tampered("signer is not the gateway Keel verified before asking");
  return { ok: true, signer: recovered.toLowerCase() };
}

/** A response body's exact bytes, refusing anything over `max` bytes. */
export async function readCapped(res: Response, max = MAX_BODY): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** GET a JSON body, refusing anything over MAX_BODY. Returns the status too, for 404 retries. */
async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const text = (await readCapped(res)).toString("utf8");
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    throw new Error("response is not JSON");
  }
}

// Preflight evidence: the gateway signer Keel verified, kept for EVIDENCE_FOR_MS.
// A failed preflight is remembered for FAILED_FOR_MS, so an outage does not send
// every bill back to NEAR AI and Intel (Intel's fetch cannot be cancelled).
let evidence: { url: string; signer: string; tcb: string; until: number } | null = null;
let failed: { url: string; reason: string; until: number } | null = null;
const FAILED_FOR_MS = 60_000;
export const clearAttested = () => {
  evidence = null;
  failed = null;
  inFlight.clear();
};

export interface PreflightInput {
  baseUrl: string; // e.g. https://cloud-api.near.ai/v1
  apiKey: string;
  timeoutMs: number;
  /** Tests only: verify quotes without the network. Defaults to Intel's PCS. */
  verifyQuote?: QuoteVerifierFn;
}

/** Before the completion: verified gateway evidence, fresh or at most 10 minutes old. Never throws. */
export async function preflight(x: PreflightInput): Promise<Check> {
  if (evidence && evidence.url === x.baseUrl && evidence.until > Date.now()) return { ok: true, signer: evidence.signer, tcb: evidence.tcb };
  if (failed && failed.url === x.baseUrl && failed.until > Date.now()) return fail(failed.reason);
  // Concurrent reviews share one preflight instead of each fetching the report and Intel's collateral.
  const running = inFlight.get(x.baseUrl);
  if (running) return running;
  const p = runPreflight(x).finally(() => inFlight.delete(x.baseUrl));
  inFlight.set(x.baseUrl, p);
  return p;
}

const inFlight = new Map<string, Promise<Check>>();

async function runPreflight(x: PreflightInput): Promise<Check> {
  evidence = null;
  const c = await freshPreflight(x);
  if (c.ok) evidence = { url: x.baseUrl, signer: c.signer, tcb: c.tcb ?? "", until: Date.now() + EVIDENCE_FOR_MS };
  else failed = { url: x.baseUrl, reason: c.reason, until: Date.now() + FAILED_FOR_MS };
  return c;
}

async function freshPreflight(x: PreflightInput): Promise<Check> {
  try {
    const deadline = Date.now() + x.timeoutMs;
    const nonce = randomBytes(32).toString("hex");
    // The key is optional here, and one that is sent must be valid: send it only when set.
    const auth: Record<string, string> = x.apiKey ? { Authorization: `Bearer ${x.apiKey}` } : {};
    const { body } = await getJson(`${x.baseUrl}/attestation/report?signing_algo=ecdsa&nonce=${nonce}`, auth, AbortSignal.timeout(x.timeoutMs));
    const report = body as { gateway_attestation?: unknown } | null;
    const verify = x.verifyQuote ?? intelVerifier(Math.max(1, deadline - Date.now()));
    return await within(checkGatewayReport(report?.gateway_attestation, nonce, verify), Math.max(1, deadline - Date.now()), "attestation check");
  } catch (e) {
    return fail(`check failed: ${clean(e instanceof Error ? e.message : "unknown error", 100)}`);
  }
}

export interface ResponseInput {
  baseUrl: string;
  apiKey: string;
  chatId: string;
  requestBody: string; // the exact bytes Keel sent
  responseBody: Uint8Array; // the exact bytes Keel got, before any decoding
  preflightSigner: string;
  timeoutMs: number;
  /** Pause before retrying a signature not recorded yet. */
  retryMs?: number;
}

/** After the completion: fetch the signature (a short, bounded retry while it is not recorded yet) and check it. Never throws. */
export async function verifyResponse(x: ResponseInput): Promise<Check> {
  try {
    if (!/^[\w.:-]{1,128}$/.test(x.chatId)) return fail("no usable chat id");
    const deadline = Date.now() + x.timeoutMs;
    const signal = AbortSignal.timeout(x.timeoutMs);
    const url = `${x.baseUrl}/signature/${encodeURIComponent(x.chatId)}?signing_algo=ecdsa`;
    let last: Check = fail("signature not found");
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) {
        const pause = Math.min(x.retryMs ?? 700, deadline - Date.now());
        if (pause <= 0) break;
        await new Promise((r) => setTimeout(r, pause));
      }
      const { status, body } = await getJson(url, { Authorization: `Bearer ${x.apiKey}` }, signal);
      if (status === 404) {
        last = fail("signature not found");
        continue;
      }
      last = await checkResponseSignature(x.requestBody, x.responseBody, body, x.preflightSigner);
      // A valid signature by another key may be a key rotation: the next answer gets fresh preflight evidence.
      if (!last.ok && last.reason === "signer is not the gateway Keel verified before asking") evidence = null;
      if (last.ok || !last.reason.startsWith("signature unavailable")) return last;
    }
    return last;
  } catch (e) {
    return fail(`check failed: ${clean(e instanceof Error ? e.message : "unknown error", 100)}`);
  }
}
