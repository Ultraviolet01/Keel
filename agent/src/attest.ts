// Checks that a NEAR AI Cloud answer is the one NEAR AI's attested gateway
// signed, for this exact request. Follows NEAR AI's own verifier
// (github.com/nearai/nearai-cloud-verifier, py/chat_verifier.py):
//   1. GET /v1/signature/{chat_id}: text "<sha256(request)>:<sha256(response)>"
//      (optionally with a prefix part), an EIP-191 signature and the signer.
//   2. The two hashes must be those of the request Keel sent and the response
//      it got, and the signature must recover to the signer.
//   3. GET /v1/attestation/report with a fresh nonce: the Intel TDX quote's
//      report_data must hold the signer and that nonce, and the enclave must
//      not be a debug one.
// What this does not do (yet): check Intel's signature on the quote itself.
// Until that is added, the quote is read, not proven genuine.
// Nothing here throws: every failure is { ok: false, reason }.

import { createHash, randomBytes } from "node:crypto";
import { recoverMessageAddress, type Hex } from "viem";

export type Check = { ok: true; signer: string } | { ok: false; reason: string };

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

/** report_data and the debug flag from an Intel TDX quote (version 4 or 5). Not a proof the quote is genuine. */
export function readQuote(quoteHex: unknown): { reportData: Buffer; debug: boolean } | null {
  if (typeof quoteHex !== "string" || quoteHex.length % 2 || !HEX.test(quoteHex)) return null;
  const q = Buffer.from(quoteHex, "hex");
  if (q.length < 48 + 584) return null;
  const version = q.readUInt16LE(0);
  if (q.readUInt32LE(4) !== 0x81) return null; // TEE type: TDX
  let body = 48;
  if (version === 5) {
    const type = q.readUInt16LE(48);
    if (type !== 2 && type !== 3) return null; // TDX 1.0 or 1.5 report body
    body += 6;
  } else if (version !== 4) return null;
  if (q.length < body + 584) return null;
  const tdAttributes = q.subarray(body + 120, body + 128);
  return { reportData: q.subarray(body + 520, body + 584), debug: (tdAttributes[0] & 1) === 1 };
}

/** Step 3: the attested report names this signer and carries Keel's nonce. */
export function checkAttestation(report: unknown, signer: string, nonce: string): Check {
  if (!report || typeof report !== "object") return fail("no attestation report");
  const r = report as { gateway_attestation?: unknown; model_attestations?: unknown };
  const all = [r.gateway_attestation, ...(Array.isArray(r.model_attestations) ? r.model_attestations : [])];
  const att = all.find((a): a is Record<string, unknown> => {
    const addr = a && typeof a === "object" ? (a as { signing_address?: unknown }).signing_address : undefined;
    return typeof addr === "string" && addr.toLowerCase() === signer.toLowerCase();
  });
  if (!att) return fail("attestation does not name the signer");
  if ((att.signing_algo ?? "ecdsa") !== "ecdsa") return fail("attestation is for another signing algorithm");
  const quote = readQuote(att.intel_quote);
  if (!quote) return fail("attestation has no readable TDX quote");
  if (quote.debug) return fail("attestation is from a debug enclave");
  const addr = Buffer.from(signer.slice(2), "hex");
  const fp = att.tls_cert_fingerprint;
  let expected: Buffer | null = Buffer.concat([addr, Buffer.alloc(12)]);
  if (typeof fp === "string" && fp) {
    // With a TLS fingerprint, report_data[0..32] = sha256(signer || fingerprint).
    expected = HEX.test(fp) && fp.length % 2 === 0 ? createHash("sha256").update(Buffer.concat([addr, Buffer.from(fp, "hex")])).digest() : null;
  }
  if (!expected || !quote.reportData.subarray(0, 32).equals(expected)) return fail("TDX quote does not bind the signer");
  if (!quote.reportData.subarray(32, 64).equals(Buffer.from(nonce, "hex"))) return fail("TDX quote is not for Keel's nonce");
  return { ok: true, signer: signer.toLowerCase() };
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

// A signer whose quote checked out recently, so each bill does not refetch the report.
const attested = new Map<string, number>();
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
}

/** Steps 1 to 3. Never throws; a timeout, an error or junk is { ok: false }. */
export async function verifyChat(x: VerifyInput): Promise<Check> {
  try {
    if (!/^[\w.:-]{1,128}$/.test(x.chatId)) return fail("no usable chat id");
    const signal = AbortSignal.timeout(x.timeoutMs);
    const auth = { Authorization: `Bearer ${x.apiKey}` };
    const model = encodeURIComponent(x.model);
    const sig = await getJson(`${x.baseUrl}/signature/${encodeURIComponent(x.chatId)}?model=${model}&signing_algo=ecdsa`, auth, signal);
    const s = await checkSignature(x.requestBody, x.responseText, sig);
    if (!s.ok) return s;
    if ((attested.get(s.signer) ?? 0) > Date.now()) return s;
    const nonce = randomBytes(32).toString("hex");
    const report = await getJson(`${x.baseUrl}/attestation/report?model=${model}&nonce=${nonce}&signing_algo=ecdsa&signing_address=${s.signer}`, auth, signal);
    const a = checkAttestation(report, s.signer, nonce);
    if (a.ok) attested.set(s.signer, Date.now() + ATTESTED_FOR_MS);
    return a;
  } catch (e) {
    return fail(`check failed: ${e instanceof Error ? e.message : "unknown error"}`.slice(0, 120));
  }
}
