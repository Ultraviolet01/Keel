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

export const REPORT_PER_VAULT = 5;
export const REPORT_MAX_BYTES = 90_000; // the server refuses a report over 100 kB

/**
 * The round's report, within the server's size limit however many vaults (anyone can create one)
 * produce events: at most REPORT_PER_VAULT each, taken in turns (every vault's first, then every
 * vault's second...), so a crowd of noisy vaults cannot push another vault's alert out.
 */
export function reportBody(all: AgentEvent[], at = Date.now()): string {
  const byVault = new Map<string, AgentEvent[]>();
  for (const e of all) {
    const list = byVault.get(e.vault) ?? [];
    if (list.length < REPORT_PER_VAULT) list.push(e);
    byVault.set(e.vault, list);
  }
  const picked: AgentEvent[] = [];
  let size = JSON.stringify({ at, events: [] }).length;
  for (let turn = 0; turn < REPORT_PER_VAULT; turn++) {
    for (const list of byVault.values()) {
      const e = list[turn];
      if (!e) continue;
      const add = JSON.stringify(e).length + 1;
      if (size + add > REPORT_MAX_BYTES) continue;
      picked.push(e);
      size += add;
    }
  }
  return JSON.stringify({ at, events: picked });
}

/** Sends the round's report; never fails the round. Returns a line for the log. */
export async function report(cfg: Config, chain: Chain, events: Event[]): Promise<string> {
  const url = cfg.notifyUrl;
  if (!url) return "notifications off (KEEL_NOTIFY_URL=off)";
  const body = reportBody(events.map(notable).filter((x): x is AgentEvent => !!x));
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
