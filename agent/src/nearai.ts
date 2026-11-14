// One NEAR AI Cloud chat call, checked as NEAR AI's verification docs set out
// (attest.ts): the gateway's attestation is verified before the completion is
// sent, and the answer's signature is checked against it afterwards. Used for
// both Keel's review of a payment and the reason it writes on a proposal, so
// neither can be swapped in transit without Keel noticing.

import { preflight, readCapped, verifyResponse, type Check, type QuoteVerifierFn } from "./attest";
import type { Config } from "./chain";

/** Tests only: verify quotes and wait for signatures without the network. */
export type AttestOptions = { verifyQuote?: QuoteVerifierFn; retryMs?: number };

export interface Ask {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}

/** The model's text, and a check of NEAR AI's signature against gateway evidence verified before asking. Never throws. */
export async function askNearAi(cfg: Config, ask: Ask, timeoutMs: number, opts: AttestOptions = {}): Promise<{ text: string; verify: () => Promise<Check> } | undefined> {
  try {
    const apiKey = cfg.nearAiKey ?? "";
    // One deadline for the whole call: preflight (at most half of it), completion and signature.
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    // Preflight: the gateway's attestation, verified before the completion is sent.
    const pre = await preflight({ baseUrl: cfg.nearAiUrl, apiKey, timeoutMs: Math.ceil(timeoutMs / 2), verifyQuote: opts.verifyQuote });
    // Kept as the exact string sent: NEAR AI signs its hash.
    const body = JSON.stringify({
      model: cfg.nearAiModel,
      max_tokens: ask.maxTokens,
      temperature: ask.temperature,
      messages: [
        { role: "system", content: ask.system },
        { role: "user", content: ask.user },
      ],
    });
    const res = await fetch(`${cfg.nearAiUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body,
      signal: AbortSignal.timeout(left()),
    });
    if (!res.ok) return undefined;
    const raw = await readCapped(res, 200_000); // exact bytes: NEAR AI signs their hash
    const parsed = JSON.parse(raw.toString("utf8")) as { id?: unknown; choices?: { message?: { content?: unknown } }[] };
    const text = parsed.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text) return undefined; // anything but text is no answer
    const chatId = typeof parsed.id === "string" ? parsed.id : "";
    return {
      text,
      verify: async () =>
        pre.ok ? verifyResponse({ baseUrl: cfg.nearAiUrl, apiKey, chatId, requestBody: body, responseBody: raw, preflightSigner: pre.signer, timeoutMs: left(), retryMs: opts.retryMs }) : pre,
    };
  } catch {
    return undefined;
  }
}
