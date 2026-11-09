// Plain-English reasons for proposals. NEAR AI Cloud writes them when
// NEARAI_API_KEY is set, Claude when ANTHROPIC_API_KEY is set, and a template
// otherwise or when either call fails. The text only explains a decision that
// plain code already made; it never decides anything.

import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./chain";

export interface ExplainInput {
  company: string;
  payee: string;
  amount: string; // formatted, for example "132.00 tUSDC"
  due: string;
  rule: string; // why the code decided to propose
  memo?: string;
}

const MAX = 270; // the vault caps reasons at 280 characters

/**
 * Keel's own facts come first. The bill's memo is text from the invoice, which
 * the payee may have written, so it goes last, quoted and labelled, and is cut
 * before it can push Keel's facts out of the 270 characters.
 */
export function template(x: ExplainInput): string {
  const facts = `Pay ${x.amount} to ${x.payee}, due ${x.due}. Needs you because ${x.rule.replace(/[.\s]+$/, "")}.`;
  if (!x.memo) return facts.slice(0, MAX);
  const room = MAX - facts.length - ' Invoice text (unverified): ""'.length;
  const memo = room > 8 ? x.memo.replace(/["\s]+/g, " ").trim() : "";
  const quoted = memo.length > room ? `${memo.slice(0, Math.max(0, room - 1))}…` : memo;
  return (quoted ? `${facts} Invoice text (unverified): "${quoted}"` : facts).slice(0, MAX);
}

const SYSTEM =
  "You write one plain sentence, under 200 characters, telling a founder why their treasury agent is asking them to approve a payment. Use only the facts given. No greetings, no exclamation marks.";

export type Writer = "near-ai" | "claude" | "template";

export async function explain(cfg: Config, x: ExplainInput): Promise<{ text: string; by: Writer }> {
  // The memo is invoice text the payee may have written; it never reaches a model.
  const facts = JSON.stringify({ ...x, memo: undefined });
  const text = cfg.nearAiKey ? await nearAi(cfg, facts) : cfg.anthropicKey ? await claude(cfg, facts) : undefined;
  if (!text) return { text: template(x), by: "template" };
  return { text: text.slice(0, MAX), by: cfg.nearAiKey ? "near-ai" : "claude" };
}

async function nearAi(cfg: Config, facts: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${cfg.nearAiUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.nearAiKey}` },
      body: JSON.stringify({
        model: cfg.nearAiModel,
        max_tokens: 120,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: facts },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content?.trim().replace(/\s+/g, " ") || undefined;
  } catch {
    return undefined;
  }
}

async function claude(cfg: Config, facts: string): Promise<string | undefined> {
  const client = new Anthropic({ apiKey: cfg.anthropicKey, timeout: 15_000, maxRetries: 1 });
  try {
    const msg = await client.messages.create({
      model: cfg.anthropicModel,
      max_tokens: 200,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [{ role: "user", content: facts }],
    });
    if (msg.stop_reason === "refusal") return undefined;
    const text = msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
      .trim()
      .replace(/\s+/g, " ");
    return text || undefined;
  } catch (e) {
    // Any API failure (bad key, rate limit, timeout) falls back to the template.
    if (!(e instanceof Anthropic.APIError)) console.error(`Claude reason failed: ${String(e).slice(0, 120)}`);
    return undefined;
  }
}
