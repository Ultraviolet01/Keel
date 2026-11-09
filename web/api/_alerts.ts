// What to email about one vault after a round, decided from what the chain
// shows now and what was already sent. No network here, so it is unit-tested.

export interface VaultPolicy {
  owner_id: string;
  paused: boolean;
  min_balance?: string;
  pending_owner?: string | null;
}

export interface VaultProposal {
  id: number;
  receiver_id: string;
  amount: string;
  reason: string;
  status: string;
  valid_until_ms?: number | null;
}

export interface DaoVote {
  id: number;
  proposer: string;
  /** Who voted already, by account. */
  votes: Record<string, string>;
  /** Vault methods it calls. */
  methods: string[];
}

/** What Keel's agent saw this round and could not sign, sent with the round. */
export interface AgentEvent {
  vault: string;
  /** refused: a bill Keel would not pay; short: the forecast runs out; vault_refused: the vault declined a payment. */
  kind: "refused" | "short" | "vault_refused";
  text: string;
  /** Same key, same alert: it is emailed once. */
  key: string;
}

export interface VaultState {
  /** Highest vault proposal id already announced. */
  lastProposal: number;
  /** Multisig proposal ids already announced. */
  daoSeen: number[];
  paused: boolean;
  pendingOwner: string | null;
  belowBuffer: boolean;
  /** Agent event keys already emailed (newest last, capped). */
  sent: string[];
}

/** One thing to tell people about. `who` picks the recipients among the vault's people. */
export interface Alert {
  vault: string;
  who: "everyone" | { voters: string[] };
  title: string;
  detail: string;
}

export interface Snapshot {
  vault: string;
  policy: VaultPolicy;
  proposals: VaultProposal[];
  dao: DaoVote[];
  /** Members of the owning multisig who may vote, if a multisig owns the vault. */
  voters: string[] | null;
  balance: bigint;
  decimals: number;
  symbol: string;
  events: AgentEvent[];
}

const SENT_CAP = 300;

export const money = (raw: string | bigint, decimals: number, symbol: string) => {
  const v = BigInt(raw);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const unit = 10n ** BigInt(decimals);
  const cents = ((a % unit) * 100n) / unit;
  return `${neg ? "-" : ""}${(a / unit).toLocaleString("en-US")}.${cents.toString().padStart(2, "0")} ${symbol}`;
};

/**
 * The alerts for one vault and the state to store after sending them. A vault
 * seen for the first time only records where things stand, so subscribing
 * does not flood anyone with old proposals.
 */
export function vaultAlerts(s: Snapshot, prev: VaultState | null): { alerts: Alert[]; next: VaultState } {
  const alerts: Alert[] = [];
  const m = (raw: string | bigint) => money(raw, s.decimals, s.symbol);
  const buffer = BigInt(s.policy.min_balance ?? "0");
  const below = buffer > 0n && s.balance < buffer;
  const pending = s.proposals.filter((p) => p.status === "pending");
  const maxId = s.proposals.reduce((x, p) => Math.max(x, p.id), -1);
  const next: VaultState = {
    lastProposal: Math.max(prev?.lastProposal ?? -1, maxId),
    daoSeen: s.dao.map((d) => d.id),
    paused: s.policy.paused,
    pendingOwner: s.policy.pending_owner ?? null,
    belowBuffer: below,
    sent: [...(prev?.sent ?? [])],
  };
  if (!prev) {
    next.sent = [...next.sent, ...s.events.map((e) => e.key)].slice(-SENT_CAP);
    return { alerts, next };
  }

  for (const p of pending.filter((p) => p.id > prev.lastProposal)) {
    const expiry = p.valid_until_ms ? ` The offer expires at ${new Date(p.valid_until_ms).toISOString().slice(11, 16)} UTC.` : "";
    alerts.push({
      vault: s.vault,
      who: "everyone",
      title: `Approval needed: ${m(p.amount)} to ${p.receiver_id}`,
      detail: `Keel proposed payment #${p.id}. Keel's reason: ${p.reason}${expiry}`,
    });
  }
  for (const d of s.dao.filter((d) => !prev.daoSeen.includes(d.id))) {
    const voters = (s.voters ?? []).filter((v) => !(v in d.votes));
    if (voters.length === 0) continue;
    alerts.push({
      vault: s.vault,
      who: { voters },
      title: `Vote needed: multisig proposal #${d.id}`,
      detail: `${d.proposer} proposed ${d.methods.join(", ") || "a change"} on this vault. Check its exact arguments under Rules before you vote.`,
    });
  }
  if (s.policy.paused && !prev.paused) alerts.push({ vault: s.vault, who: "everyone", title: "Payments paused", detail: "Nothing moves until the owner resumes payments." });
  if (!s.policy.paused && prev.paused) alerts.push({ vault: s.vault, who: "everyone", title: "Payments resumed", detail: "Keel pays inside the limits again." });
  if (s.policy.pending_owner && s.policy.pending_owner !== prev.pendingOwner) {
    alerts.push({
      vault: s.vault,
      who: "everyone",
      title: `Ownership offered to ${s.policy.pending_owner}`,
      detail: "Nothing changes until that account accepts. Check the vault's payees, bills and limits before accepting.",
    });
  }
  if (below && !prev.belowBuffer) {
    alerts.push({
      vault: s.vault,
      who: "everyone",
      title: "Cash below the buffer",
      detail: `The vault holds ${m(s.balance)}, under its cash buffer of ${m(buffer)}. Keel holds back non-critical bills until it is topped up.`,
    });
  }
  for (const e of s.events.filter((e) => !next.sent.includes(e.key))) {
    const title = e.kind === "refused" ? "Keel refused a bill" : e.kind === "short" ? "Cash runs short" : "The vault declined a payment";
    alerts.push({ vault: s.vault, who: "everyone", title, detail: e.text });
    next.sent.push(e.key);
  }
  next.sent = next.sent.slice(-SENT_CAP);
  return { alerts, next };
}

/** The accounts an alert goes to: the vault's owner, or its multisig's members. */
export function recipients(alert: Alert, owner: string, members: string[] | null): string[] {
  if (typeof alert.who === "object") return alert.who.voters;
  return members ?? [owner];
}

export interface Transfer {
  at: number;
  delta: bigint;
  counterparty: string;
}

/** The daily digest lines for one vault: what moved after `since`, oldest first. */
export function digestLines(transfers: Transfer[], since: number, decimals: number, symbol: string, names: Record<string, string>, waiting: number): string[] {
  const lines = transfers
    .filter((t) => t.at > since)
    .sort((a, b) => a.at - b.at)
    .map((t) => {
      const who = names[t.counterparty] ?? t.counterparty;
      return t.delta < 0n ? `Paid ${money(-t.delta, decimals, symbol)} to ${who}` : `Received ${money(t.delta, decimals, symbol)} from ${who}`;
    });
  if (lines.length && waiting) lines.push(`${waiting} payment${waiting === 1 ? "" : "s"} still waiting for approval`);
  return lines;
}

/** The company a vault belongs to, as founders see it: "compass.keel.testnet" is Compass. */
export const companyOf = (vault: string) => {
  const name = vault.split(".")[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
};

/** A section heading naming the company and its vault, so founders with many companies know which one. */
export const companyTitle = (vault: string) => `${companyOf(vault)} (${vault})`;

/** The subject of an alert email: the company first, then what happened. */
export function alertSubject(alerts: { vault: string; title: string }[]): string {
  const companies = [...new Set(alerts.map((a) => companyOf(a.vault)))];
  if (alerts.length === 1) return `Keel · ${companies[0]}: ${alerts[0].title}`;
  return `Keel: ${alerts.length} things need you in ${companies.join(", ")}`;
}

/** Shown in the first emails: a new sender often lands in Spam. */
export const SPAM_HINT = "If this email was in Spam or Promotions, mark it Not spam (or move it to your inbox) so Keel's alerts reach you.";

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A plain email: a heading, sections of lines, a button and an unsubscribe link. */
export function renderEmail(o: { heading: string; sections: { title: string; lines: string[] }[]; link: string; linkText: string; unsubscribe?: string }) {
  const text = [
    o.heading,
    "",
    ...o.sections.flatMap((s) => [s.title, ...s.lines.map((l) => `- ${l}`), ""]),
    `${o.linkText}: ${o.link}`,
    ...(o.unsubscribe ? ["", `Stop these emails: ${o.unsubscribe}`] : []),
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#12313b">
<h2 style="color:#0b5c55;margin:0 0 16px">${esc(o.heading)}</h2>
${o.sections
  .map((s) => `<h3 style="margin:18px 0 6px;font-size:15px">${esc(s.title)}</h3><ul style="margin:0;padding-left:18px">${s.lines.map((l) => `<li style="margin:4px 0">${esc(l)}</li>`).join("")}</ul>`)
  .join("\n")}
<p style="margin:22px 0"><a href="${esc(o.link)}" style="background:#0b5c55;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${esc(o.linkText)}</a></p>
<p style="font-size:12px;color:#6b7c80">Keel runs on NEAR testnet with test tokens.${o.unsubscribe ? ` <a href="${esc(o.unsubscribe)}" style="color:#6b7c80">Stop these emails</a>.` : ""}</p>
</div>`;
  return { text, html };
}
