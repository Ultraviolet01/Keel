// Checks that a NEAR AI Cloud answer is the one NEAR AI's attested gateway
// signed, for this exact request, and that the gateway's key lives in a
// genuine Intel TDX enclave. Follows NEAR AI's own verifier
// (github.com/nearai/nearai-cloud-verifier, py/chat_verifier.py and
// py/model_verifier.py):
//   1. GET /v1/signature/{chat_id}: text "<sha256(request)>:<sha256(response)>"
//      (optionally with a prefix part), an EIP-191 signature and the signer.
//   2. The two hashes must be those of the request Keel sent and the response
//      it got, and the signature must recover to the signer.
//   3. GET /v1/attestation/report with a fresh nonce. The Intel TDX quote in it
//      is verified against Intel's collateral (PCS) up to Intel's SGX root CA,
//      pinned below: certificate chain and revocation lists, the quoting
//      enclave's identity, the quote's signature, the platform's TCB level, and
//      no debug enclave (Phala's dcap-qvl, the library NEAR AI's verifier uses).
//      Only then does its report_data count: it must hold the signer and the nonce.
// What this does not check: the model provider's own GPU attestation. NEAR AI's
// gateway signs the answers; the model behind it is attested by its provider.
// Nothing here throws: every failure is { ok: false, reason }.

import { createHash, randomBytes } from "node:crypto";
import { INTEL_PCS_URL, QuoteVerifier, getCollateral, type Collateral, type TDReport10, type TDReport15, type TDReport15Ex } from "@phala/dcap-qvl";
import { recoverMessageAddress, type Hex } from "viem";

export type Check = { ok: true; signer: string; tcb?: string } | { ok: false; reason: string };

const MAX_BODY = 1_000_000; // the real report is about 180 kB
const HEX = /^[0-9a-f]*$/i;

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const fail = (reason: string): Check => ({ ok: false, reason });

/** Step 2: the signature covers this request and this response, and names its signer. */
export async function checkSignature(requestBody: string, responseText: string, sig: unknown): Promise<Check> {
  if (!sig || typeof sig !== "object") return fail("no signature");
  const { text, signature, signing_address } = sig as Record<string, unknown>;
  if (typeof text !== "string" || text.length > 300) return fail("signature text missing or malformed");
  if (typeof signature !== "string" || !/^0x[0-9a-f]{130}$/i.test(signature)) return fail("signature malformed");
  if (typeof signing_address !== "string" || !/^0x[0-9a-f]{40}$/i.test(signing_address)) return fail("signer malformed");
  const parts = text.split(":");
  if (parts.length !== 2 && parts.length !== 3) return fail("signature text malformed");
  const [reqHash, resHash] = parts.slice(-2).map((p) => p.toLowerCase());
  if (reqHash !== sha256Hex(requestBody)) return fail("signed request is not the one Keel sent");
  if (resHash !== sha256Hex(responseText)) return fail("response changed after it was signed");
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message: text, signature: signature as Hex });
  } catch {
    return fail("signature does not recover");
  }
  if (recovered.toLowerCase() !== signing_address.toLowerCase()) return fail("signed by another key than the one named");
  return { ok: true, signer: signing_address.toLowerCase() };
}

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

/** TCB levels Keel accepts: the platform is patched (software hardening is the enclave's own business). */
const GOOD_TCB = new Set(["UpToDate", "SWHardeningNeeded"]);

/** What a verified quote proves: its report_data, and the platform's TCB level. */
export type QuoteProof = { reportData: Buffer; tcb: string };
/** Verifies a TDX quote or throws. */
export type QuoteVerifierFn = (quote: Buffer) => Promise<QuoteProof>;

/** Verifies a quote against given collateral at a given time, up to the pinned Intel root. Throws on failure. */
export function verifyQuote(quote: Buffer, collateral: Collateral, nowSecs: number): QuoteProof {
  if (createHash("sha256").update(INTEL_ROOT_CA).digest("hex") !== INTEL_ROOT_SHA256) throw new Error("pinned Intel root CA changed");
  const r = new QuoteVerifier(INTEL_ROOT_CA).verify(quote, collateral, nowSecs); // debug enclaves are refused by default
  const d = r.report.data;
  // TD 1.0 holds report_data itself; TD 1.5 nests the 1.0 report as `base`, and 1.5ex nests 1.5.
  const td10 = r.report.type === "td10" ? (d as TDReport10) : r.report.type === "td15" ? (d as TDReport15).base : r.report.type === "td15ex" ? (d as TDReport15Ex).base.base : null;
  if (!td10) throw new Error("not a TDX quote");
  return { reportData: Buffer.from(td10.reportData), tcb: r.status };
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

/** Step 3: an Intel-verified quote whose report_data names this signer and carries Keel's nonce. */
export async function checkAttestation(report: unknown, signer: string, nonce: string, verify: QuoteVerifierFn): Promise<Check> {
  if (!report || typeof report !== "object") return fail("no attestation report");
  const r = report as { gateway_attestation?: unknown; model_attestations?: unknown };
  const all = [r.gateway_attestation, ...(Array.isArray(r.model_attestations) ? r.model_attestations : [])];
  const att = all.find((a): a is Record<string, unknown> => {
    const addr = a && typeof a === "object" ? (a as { signing_address?: unknown }).signing_address : undefined;
    return typeof addr === "string" && addr.toLowerCase() === signer.toLowerCase();
  });
  if (!att) return fail("attestation does not name the signer");
  if ((att.signing_algo ?? "ecdsa") !== "ecdsa") return fail("attestation is for another signing algorithm");
  const hex = att.intel_quote;
  if (typeof hex !== "string" || !hex || hex.length % 2 || !HEX.test(hex)) return fail("attestation has no TDX quote");
  let proof: QuoteProof;
  try {
    proof = await verify(Buffer.from(hex, "hex"));
  } catch (e) {
    return fail(`Intel check failed: ${e instanceof Error ? e.message : "unknown error"}`.slice(0, 120));
  }
  if (!GOOD_TCB.has(proof.tcb)) return fail(`enclave platform TCB is ${proof.tcb}`);
  const addr = Buffer.from(signer.slice(2), "hex");
  const fp = att.tls_cert_fingerprint;
  let expected: Buffer | null = Buffer.concat([addr, Buffer.alloc(12)]);
  if (typeof fp === "string" && fp) {
    // With a TLS fingerprint, report_data[0..32] = sha256(signer || fingerprint).
    expected = HEX.test(fp) && fp.length % 2 === 0 ? createHash("sha256").update(Buffer.concat([addr, Buffer.from(fp, "hex")])).digest() : null;
  }
  if (proof.reportData.length !== 64) return fail("TDX quote has no report data");
  if (!expected || !proof.reportData.subarray(0, 32).equals(expected)) return fail("TDX quote does not bind the signer");
  if (!proof.reportData.subarray(32, 64).equals(Buffer.from(nonce, "hex"))) return fail("TDX quote is not for Keel's nonce");
  return { ok: true, signer: signer.toLowerCase(), tcb: proof.tcb };
}

/** GET a JSON body, refusing anything over MAX_BODY. */
async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers, signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// A signer whose quote checked out recently, so each bill does not refetch the report and collateral.
const attested = new Map<string, { until: number; tcb: string }>();
const ATTESTED_FOR_MS = 10 * 60_000;
export const clearAttested = () => attested.clear();

export interface VerifyInput {
  baseUrl: string; // e.g. https://cloud-api.near.ai/v1
  apiKey: string;
  model: string;
  chatId: string;
  requestBody: string; // the exact bytes Keel sent
  responseText: string; // the exact bytes Keel got
  timeoutMs: number;
  /** Tests only: verify quotes without the network. Defaults to Intel's PCS. */
  verifyQuote?: QuoteVerifierFn;
}

/** Steps 1 to 3. Never throws; a timeout, an error or junk is { ok: false }. */
export async function verifyChat(x: VerifyInput): Promise<Check> {
  try {
    if (!/^[\w.:-]{1,128}$/.test(x.chatId)) return fail("no usable chat id");
    const deadline = Date.now() + x.timeoutMs;
    const signal = AbortSignal.timeout(x.timeoutMs);
    const auth = { Authorization: `Bearer ${x.apiKey}` };
    const model = encodeURIComponent(x.model);
    const sig = await getJson(`${x.baseUrl}/signature/${encodeURIComponent(x.chatId)}?model=${model}&signing_algo=ecdsa`, auth, signal);
    const s = await checkSignature(x.requestBody, x.responseText, sig);
    if (!s.ok) return s;
    const known = attested.get(s.signer);
    if (known && known.until > Date.now()) return { ...s, tcb: known.tcb };
    const nonce = randomBytes(32).toString("hex");
    const report = await getJson(`${x.baseUrl}/attestation/report?model=${model}&nonce=${nonce}&signing_algo=ecdsa&signing_address=${s.signer}`, auth, signal);
    const verify = x.verifyQuote ?? intelVerifier(Math.max(1, deadline - Date.now()));
    const a = await within(checkAttestation(report, s.signer, nonce, verify), Math.max(1, deadline - Date.now()), "attestation check");
    if (a.ok) attested.set(s.signer, { until: Date.now() + ATTESTED_FOR_MS, tcb: a.tcb ?? "" });
    return a;
  } catch (e) {
    return fail(`check failed: ${e instanceof Error ? e.message : "unknown error"}`.slice(0, 120));
  }
}
