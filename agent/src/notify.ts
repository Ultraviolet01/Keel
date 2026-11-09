// After each round Keel tells its server what it saw but did not sign
// (refused bills, a forecast that runs short, payments the vault declined).
// The server reads every vault from the chain itself and emails the people
// who turned notifications on. The report is signed with Keel's agent key.

import type { Chain, Config } from "./chain";
import type { Event } from "./loop";

export interface AgentEvent {
  vault: string;
  kind: "refused" | "short" | "vault_refused";
  text: string;
  key: string;
}

/** The round's events worth an email: the notice the agent attached, in the founder's words. */
export function notable(e: Event): AgentEvent | null {
  if (e.notice) return { vault: e.vault, ...e.notice };
  return null;
}

/** Sends the round's report; never fails the round. Returns a line for the log. */
export async function report(cfg: Config, chain: Chain, events: Event[]): Promise<string> {
  const url = cfg.notifyUrl;
  if (!url) return "notifications off (KEEL_NOTIFY_URL=off)";
  const body = JSON.stringify({ at: Date.now(), events: events.map(notable).filter((x): x is AgentEvent => !!x) });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-keel-signature": chain.signReport(body) },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const out = (await res.json().catch(() => ({}))) as { followed?: number; emails?: number; error?: string };
    return res.ok ? `notifications: ${out.followed ?? 0} followed vaults, ${out.emails ?? 0} emails sent` : `notifications skipped: ${out.error ?? res.status}`;
  } catch (e) {
    return `notifications skipped: ${String(e).slice(0, 120)}`;
  }
}
