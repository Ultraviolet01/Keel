// Plain-English reasons for proposals. NEAR AI Cloud writes them when
// NEARAI_API_KEY is set; otherwise a template does. The text only explains a
// decision that plain code already made; it never decides anything.

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
  const facts = `Pay ${x.amount} to ${x.payee}, due ${x.due}. Needs you because ${x.rule}.`;
  if (!x.memo) return facts.slice(0, MAX);
  const room = MAX - facts.length - ' Invoice text (unverified): ""'.length;
  const memo = room > 8 ? x.memo.replace(/["\s]+/g, " ").trim() : "";
  const quoted = memo.length > room ? `${memo.slice(0, Math.max(0, room - 1))}…` : memo;
  return (quoted ? `${facts} Invoice text (unverified): "${quoted}"` : facts).slice(0, MAX);
}

export async function explain(cfg: Config, x: ExplainInput): Promise<{ text: string; by: "near-ai" | "template" }> {
  if (!cfg.nearAiKey) return { text: template(x), by: "template" };
  try {
    const res = await fetch(`${cfg.nearAiUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.nearAiKey}` },
      body: JSON.stringify({
        model: cfg.nearAiModel,
        max_tokens: 120,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You write one plain sentence, under 200 characters, telling a founder why their treasury agent is asking them to approve a payment. Use only the facts given. No greetings, no exclamation marks.",
          },
          // The memo is invoice text the payee may have written; it never reaches the model.
          { role: "user", content: JSON.stringify({ ...x, memo: undefined }) },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content?.trim().replace(/\s+/g, " ");
    if (!text) return { text: template(x), by: "template" };
    return { text: text.slice(0, MAX), by: "near-ai" };
  } catch {
    return { text: template(x), by: "template" };
  }
}
