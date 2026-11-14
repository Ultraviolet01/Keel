// Mutation fuzz of the whole NEAR AI review: start from a valid, verified exchange, change exactly
// one thing an attacker on the path could touch, and require that (1) the result is never reported
// as attested and (2) Keel never pays a bill NEAR AI genuinely said to propose or refuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { clearAttested, sha256Hex, type QuoteVerifierFn } from "./attest";
import { review, stricter } from "./review";
import type { Config } from "./chain";

const fx = JSON.parse(readFileSync(new URL("./fixtures/nearai-attestation.json", import.meta.url), "utf8"));
const ga = fx.gateway_attestation;
const gatewayKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const otherKey = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const TD = 48;
// Stands in for Intel's check (attest.test.ts runs the real one): reads the quote's measured fields.
const standIn: QuoteVerifierFn = async (q) => ({ reportData: q.subarray(TD + 520, TD + 584), mrConfigId: q.subarray(TD + 184, TD + 232), rtMr3: q.subarray(TD + 472, TD + 520), debug: (q[TD + 120] & 1) === 1, tcb: "UpToDate" });

// A small deterministic PRNG, so a failure can be replayed.
let seed = 20261114;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const flip = (s: string) => {
  if (!s) return "x";
  const i = Math.floor(rnd() * s.length);
  const c = s[i];
  const r = /[0-9a-f]/i.test(c) ? (c === "0" ? "1" : "0") : c === "a" ? "b" : "a";
  return s.slice(0, i) + r + s.slice(i + 1);
};

const MUTATIONS = ["chat-byte", "chat-verdict", "chat-id", "sig-text", "sig-signature", "sig-address", "sig-kind", "sig-algo", "sig-other-key", "sig-other-request", "report-nonce", "report-report-data", "report-signer", "report-quote-binding", "report-quote-nonce", "report-mrconfig", "report-rtmr3", "report-event-log", "report-app-compose", "report-algo"] as const;
type Mutation = (typeof MUTATIONS)[number];

/** Whether the mutated chat reply still had a readable id and text: if not, it is as good as blocked. */
let envelopeIntact = true;

async function exchange(verdict: "ok" | "propose" | "refuse", m: Mutation | null) {
  let lastRequest = "";
  let lastResponse = "";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname.endsWith("/attestation/report")) {
        const nonce = url.searchParams.get("nonce") ?? "";
        const q = Buffer.from(ga.intel_quote, "hex");
        Buffer.concat([Buffer.from(gatewayKey.address.slice(2), "hex"), Buffer.alloc(12), Buffer.from(nonce, "hex")]).copy(q, TD + 520);
        if (m === "report-quote-binding") q[TD + 520 + Math.floor(rnd() * 20)] ^= 1;
        if (m === "report-quote-nonce") q[TD + 552 + Math.floor(rnd() * 32)] ^= 1;
        if (m === "report-mrconfig") q[TD + 184 + Math.floor(rnd() * 48)] ^= 1;
        if (m === "report-rtmr3") q[TD + 472 + Math.floor(rnd() * 48)] ^= 1;
        const att: Record<string, unknown> = { ...ga, signing_address: gatewayKey.address, request_nonce: nonce, intel_quote: q.toString("hex"), report_data: q.subarray(TD + 520, TD + 584).toString("hex") };
        if (m === "report-nonce") att.request_nonce = flip(nonce);
        if (m === "report-report-data") att.report_data = flip(att.report_data as string);
        if (m === "report-signer") att.signing_address = otherKey.address;
        if (m === "report-algo") att.signing_algo = pick(["ed25519", "ECDSA", "", undefined]);
        if (m === "report-app-compose") att.info = { tcb_info: { app_compose: flip(ga.info.tcb_info.app_compose) } };
        if (m === "report-event-log") {
          const ev = JSON.parse(ga.event_log);
          const i3 = ev.map((e: { imr: number }, i: number) => (e.imr === 3 ? i : -1)).filter((i: number) => i >= 0);
          const i = pick(i3 as number[]);
          ev[i] = { ...ev[i], event_payload: flip(ev[i].event_payload || "00") };
          att.event_log = JSON.stringify(ev);
        }
        return res.end(JSON.stringify({ gateway_attestation: att }));
      }
      if (url.pathname.endsWith("/chat/completions")) {
        lastRequest = raw;
        lastResponse = JSON.stringify({ id: "chat-1", choices: [{ message: { content: JSON.stringify({ verdict, reason: "the payee looks like Northwind but is not" }) } }] });
        let out = lastResponse;
        envelopeIntact = true;
        if (m === "chat-byte") out = flip(out);
        if (m === "chat-verdict") out = out.replace(`\\"${verdict}\\"`, verdict === "ok" ? '\\"refuse\\"' : '\\"ok\\"');
        if (m === "chat-id") out = out.replace('"chat-1"', '"chat-2"');
        try {
          const e = JSON.parse(out);
          envelopeIntact = typeof e?.id === "string" && typeof e?.choices?.[0]?.message?.content === "string";
        } catch {
          envelopeIntact = false;
        }
        return res.end(out);
      }
      if (url.pathname.includes("/signature/")) {
        const signer = m === "sig-other-key" ? otherKey : gatewayKey;
        const req2 = m === "sig-other-request" ? lastRequest.replace("northwlnd", "northwind") : lastRequest; // a signature for another bill
        const resBody = url.pathname.endsWith("chat-2") ? lastResponse.replace("Northwind", "Eastwind") : lastResponse;
        const text = `${sha256Hex(req2)}:${sha256Hex(resBody)}`;
        const sig: Record<string, unknown> = { signature_kind: "gateway", signing_algo: "ecdsa", text, signature: await signer.signMessage({ message: text }), signing_address: signer.address };
        if (m === "sig-text") sig.text = flip(text);
        if (m === "sig-signature") sig.signature = flip(sig.signature as string);
        if (m === "sig-address") sig.signing_address = otherKey.address;
        if (m === "sig-kind") sig.signature_kind = pick(["provider_tee", "Gateway", "", undefined]);
        if (m === "sig-algo") sig.signing_algo = pick(["ed25519", "ECDSA", undefined]);
        return res.end(JSON.stringify(sig));
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const cfg = { nearAiKey: "k", nearAiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, nearAiModel: "m", anthropicModel: "x" } as Config;
  clearAttested();
  try {
    return await review(cfg, { company: "acme", payee: "northwlnd-keel.testnet", amount: "2.00 USDC", due: "2026-11-26", history: [], knownPayees: [] }, 2000, { verifyQuote: standIn, retryMs: 5 });
  } finally {
    server.close();
  }
}

const pay = { kind: "pay" as const, reason: "rules" };

test("every unmutated exchange verifies (the fuzz baseline)", async () => {
  for (const verdict of ["ok", "propose", "refuse"] as const) assert.equal((await exchange(verdict, null))?.attested, true, verdict);
});

test("mutation fuzz: one change anywhere is never attested, and never turns a warning into a payment", async () => {
  for (let i = 0; i < 240; i++) {
    const verdict = pick(["ok", "propose", "refuse"] as const);
    const m = MUTATIONS[i % MUTATIONS.length];
    const v = await exchange(verdict, m);
    const what = `#${i} ${m} on ${verdict}: ${JSON.stringify(v)}`;
    assert.notEqual(v?.attested, true, what);
    // Destroying the reply's envelope is the same as blocking NEAR AI: Keel's rules decide (by design).
    if (verdict !== "ok" && envelopeIntact) assert.notEqual(stricter(pay, v).kind, "pay", what);
  }
});
