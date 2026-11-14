// Text from payees (invoice memos, account names, vendor names) checked by plain code
// before any model reads it, and cleaned before it reaches logs or the chain.

/**
 * Text safe for logs and for a proposal reason on chain: control characters, terminal
 * escapes and bidi or zero-width marks become spaces, and runs of whitespace one space.
 */
export const printable = (s: string) =>
  s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();

// Invoice text written to steer a reviewer rather than to bill anyone. Checked by plain code before any
// model sees it, so no model can be talked past it. Ordinary invoice wording does not match.
const STEERING = [
  /\bverdicts?\b/i,
  /\{\s*"/,
  /\b(ignore|disregard|forget|override|bypass)\b.{0,40}\b(instructions?|rules?|checks?|prompts?|above|previous|system|guidelines?)\b/i,
  /\b(system prompt|as an ai|language model|you are (an?|the) (ai|assistant|model|reviewer|agent))\b/i,
  /(^|[^a-z0-9])(system|assistant|user)\s*:/i,
  /\b(say|answer|respond|reply|return|output|classify)\b.{0,25}\b(ok|okay|approve[ds]?|safe|legitimate|"ok")\b/i,
  /\b(do not|don't|never)\b.{0,25}\b(flag|propose|refuse|report|question|check|escalate)\b/i,
  /\b(treasury|payment) (agent|bot|ai|reviewer)\b/i,
  // Text addressed to whoever, or whatever, checks the payment.
  /\b(whoever|anyone|the (automated )?(checker|reviewer|system|bot|ai))\b.{0,30}\b(checks?|reviews?|reads?|reading|checking)\b/i,
  /\b(automated|ai|bot)\s+(checker|check|review|reviewer|system|agent)\b/i,
  // Claims that no review is needed.
  /\bno (further |human |manual )?(review|check|approval|sign-?off)s? (is |are )?(needed|required|necessary)\b/i,
  /\bpre[- ]?(cleared|approved|authori[sz]ed|verified)\b/i,
  // Requests to relabel the payment.
  /\b(mark|treat|consider|label|flag|classify)\b.{0,25}\b(fine|ok|okay|acceptable|safe|routine|normal|legit(imate)?|approved|clean)\b/i,
  /\bgreen ?light\b|\bnothing to see\b/i,
  /\b(prior|previous|earlier|above) (guidance|instructions?|rules?|directions?|prompt)\b/i,
];

/** The same text with obfuscation undone: "I.g.n.o.r.e" and "Ign0re" both read "ignore". */
const deobfuscate = (t: string) =>
  t
    .replace(/\b(\w)(?:[.\-_*·•]\w\b)+/g, (m) => m.replace(/[.\-_*·•]/g, ""))
    .replace(/[0134578@$]/g, (c) => ({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s" })[c] ?? c);

// Cyrillic and Greek letters that look Latin, folded so "Іgnore" (Cyrillic І) reads as "Ignore".
const LOOKALIKE: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ԛ": "q", "ԝ": "w", "ɡ": "g",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "І": "I", "Ј": "J", "Ѕ": "S",
  "α": "a", "ε": "e", "ο": "o", "ρ": "p", "ν": "v", "τ": "t", "ι": "i", "κ": "k",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};

/** Whether an invoice memo tries to give instructions to whoever reviews it. */
export function steersReviewer(memo: string | undefined): boolean {
  if (!memo) return false;
  // Fold lookalikes first: fullwidth and other compatibility forms (NFKC), then Cyrillic and Greek letters.
  const text = [...printable(memo).normalize("NFKC")].map((c) => LOOKALIKE[c] ?? c).join("").replace(/[‘’]/g, "'");
  const plain = deobfuscate(text);
  return STEERING.some((r) => r.test(text) || r.test(plain));
}

