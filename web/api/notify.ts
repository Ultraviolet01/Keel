// /api/notify: email notifications for Keel. One Vercel Function, by action:
//
//   POST ?action=subscribe  a wallet-signed message naming an email; sends a confirmation link
//   GET  ?action=confirm&token=…      turns the emails on
//   GET  ?action=unsubscribe&token=…  turns them off and forgets the address
//   GET  ?action=status&account=…     whether an account gets emails (address masked)
//   POST ?action=test       a wallet-signed message; sends a test email
//   POST ?action=run        Keel's agent, signed with its key, after each round:
//                           emails what needs people now, and once a day a digest
//
// Needs BLOB_STORE_ID (the private Blob store, reached with Vercel OIDC) or BLOB_READ_WRITE_TOKEN, GMAIL_USER and
// GMAIL_APP_PASSWORD (a Gmail app password) in the Vercel project.

import { SPAM_HINT, alertSubject, companyOf, companyTitle, digestLines, recipients, renderEmail, vaultAlerts, type AgentEvent, type Alert, type VaultState } from "./_alerts.js";
import {
  APP_URL,
  allSubs,
  getSub,
  mailReady,
  maskEmail,
  newToken,
  readJson,
  readVault,
  removeJson,
  saveSub,
  sendMail,
  teamOf,
  tokenPath,
  transfers,
  vaultOwners,
  verifyAgent,
  verifySigned,
  writeJson,
  type SignedRequest,
  type Subscriber,
  type Team,
} from "./_notify.js";

const fail = (status: number, error: string) => Response.json({ error }, { status });
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;
const DIGEST_HOUR_UTC = 7;

function page(title: string, text: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 16px;color:#12313b"><h1 style="color:#0b5c55">${title}</h1><p>${text}</p><p><a href="${APP_URL}/app">Open Keel</a></p></body>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function subscribe(req: SignedRequest & { email?: string }): Promise<Response> {
  const fields = await verifySigned(req, "subscribe");
  const email = (fields.email ?? "").toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) return fail(400, "That email address does not look right.");
  const old = await getSub(req.accountId);
  if (old && !old.confirmed && Date.now() - old.createdAt < 60_000) return fail(429, "A confirmation email was just sent. Wait a minute before asking again.");
  if (old) await Promise.all([removeJson(tokenPath(old.confirmToken)), removeJson(tokenPath(old.unsubToken))]);
  const sub: Subscriber = { account: req.accountId, email, confirmed: false, confirmToken: newToken(), unsubToken: newToken(), createdAt: Date.now() };
  await Promise.all([
    saveSub(sub),
    writeJson(tokenPath(sub.confirmToken), { account: sub.account, kind: "confirm" }),
    writeJson(tokenPath(sub.unsubToken), { account: sub.account, kind: "unsubscribe" }),
  ]);
  await sendMail(
    email,
    "Confirm Keel notifications",
    renderEmail({
      heading: "Confirm your Keel notifications",
      sections: [
        {
          title: `For ${sub.account}`,
          lines: [
            "You will get an email when a payment or a multisig vote waits for you, when Keel refuses a bill, and when cash runs low.",
            "Once a day, a short digest of what Keel paid and received, only if something happened.",
            "If you did not ask for this, ignore this email: nothing is sent until you confirm.",
            SPAM_HINT,
          ],
        },
      ],
      link: `${APP_URL}/api/notify?action=confirm&token=${sub.confirmToken}`,
      linkText: "Confirm",
    }),
  );
  return Response.json({ ok: true, email: maskEmail(email) });
}

async function byToken(token: string | null, kind: string): Promise<Subscriber | null> {
  if (!token || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const t = await readJson<{ account: string; kind: string }>(tokenPath(token));
  if (!t || t.kind !== kind) return null;
  return getSub(t.account);
}

async function test(req: SignedRequest): Promise<Response> {
  await verifySigned(req, "test");
  const sub = await getSub(req.accountId);
  if (!sub?.confirmed) return fail(404, "Turn on notifications and confirm your email first.");
  if (sub.lastTestAt && Date.now() - sub.lastTestAt < 60_000) return fail(429, "A test email was just sent. Wait a minute.");
  sub.lastTestAt = Date.now();
  await saveSub(sub);
  await sendMail(
    sub.email,
    "Keel test notification",
    renderEmail({
      heading: "This is a Keel test notification",
      sections: [{ title: `For ${sub.account}`, lines: ["Notifications work. Real ones arrive when something needs you, and in a daily digest, each naming the company it is about.", SPAM_HINT] }],
      link: `${APP_URL}/app`,
      linkText: "Open Keel",
      unsubscribe: `${APP_URL}/api/notify?action=unsubscribe&token=${sub.unsubToken}`,
    }),
  );
  return Response.json({ ok: true });
}

/** After each agent round: alerts for every vault someone follows, and the daily digests. */
async function run(events: AgentEvent[]): Promise<Response> {
  const subs = (await allSubs()).filter((s) => s.confirmed);
  if (subs.length === 0) return Response.json({ ok: true, followed: 0, emails: 0 });
  const byAccount = new Map(subs.map((s) => [s.account, s]));

  // Who each vault belongs to: its owner, or the members of the multisig that owns it.
  const owners = await vaultOwners();
  const teams = new Map<string, Team | null>();
  for (const o of new Set(owners.values())) teams.set(o, await teamOf(o));
  const people = (owner: string) => teams.get(owner)?.members ?? [owner];
  const followed = [...owners].filter(([, o]) => people(o).some((a) => byAccount.has(a)));

  const inbox = new Map<string, Alert[]>();
  const vaultsOf = new Map<string, string[]>();
  const views = new Map<string, Awaited<ReturnType<typeof readVault>>>();
  for (const [vault, owner] of followed) {
    const team = teams.get(owner) ?? null;
    let v;
    try {
      v = await readVault(vault, !!team);
    } catch {
      continue;
    }
    views.set(vault, v);
    for (const a of people(owner)) vaultsOf.set(a, [...(vaultsOf.get(a) ?? []), vault]);
    const statePath = `state/${vault}.json`;
    const prev = await readJson<VaultState>(statePath);
    const { alerts, next } = vaultAlerts(
      { vault, policy: v.policy, proposals: v.proposals, dao: v.dao, voters: team?.voters ?? null, balance: v.balance, decimals: v.decimals, symbol: v.symbol, events: events.filter((e) => e.vault === vault) },
      prev,
    );
    for (const al of alerts) for (const a of recipients(al, owner, team?.members ?? null)) if (byAccount.has(a)) inbox.set(a, [...(inbox.get(a) ?? []), al]);
    await writeJson(statePath, next);
  }

  let emails = 0;
  const unsub = (s: Subscriber) => `${APP_URL}/api/notify?action=unsubscribe&token=${s.unsubToken}`;
  for (const [account, alerts] of inbox) {
    const s = byAccount.get(account)!;
    const byVault = new Map<string, Alert[]>();
    for (const al of alerts) byVault.set(al.vault, [...(byVault.get(al.vault) ?? []), al]);
    const subject = alertSubject(alerts);
    try {
      await sendMail(
        s.email,
        subject,
        renderEmail({
          heading: alerts.length === 1 ? `${companyOf(alerts[0].vault)}: ${alerts[0].title}` : `${alerts.length} things need you`,
          sections: [...byVault].map(([vault, list]) => ({ title: companyTitle(vault), lines: list.map((a) => `${a.title}. ${a.detail}`) })),
          link: `${APP_URL}/app`,
          linkText: "Open Keel",
          unsubscribe: unsub(s),
        }),
      );
      emails++;
    } catch {
      /* one bad address must not stop the others */
    }
  }

  // Daily digest, after 07:00 UTC, only when something moved.
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() >= DIGEST_HOUR_UTC) {
    for (const s of subs.filter((s) => s.digestDay !== today)) {
      const since = s.digestAt ?? Date.now() - 86_400_000;
      const sections = [];
      for (const vault of vaultsOf.get(s.account) ?? []) {
        const v = views.get(vault)!;
        const waiting = v.proposals.filter((p) => p.status === "pending").length;
        const lines = digestLines(await transfers(vault, v.policy.token_id), since, v.decimals, v.symbol, v.names, waiting);
        if (lines.length) sections.push({ title: companyTitle(vault), lines });
      }
      if (sections.length) {
        try {
          await sendMail(s.email, `Keel daily digest: ${sections.map((x) => x.title.split(" (")[0]).join(", ")}`, renderEmail({ heading: "What moved in the last day", sections, link: `${APP_URL}/app`, linkText: "Open Keel", unsubscribe: unsub(s) }));
          emails++;
        } catch {
          continue;
        }
      }
      s.digestDay = today;
      s.digestAt = Date.now();
      await saveSub(s);
    }
  }
  return Response.json({ ok: true, followed: followed.length, emails });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    // On Vercel the Blob store is reached with the deployment's short-lived OIDC credentials (BLOB_STORE_ID);
    // a long-lived BLOB_READ_WRITE_TOKEN also works, for copies hosted elsewhere.
    if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) return fail(503, "Notifications are not set up on this deployment (no Blob store).");
    try {
      if (request.method === "GET" && action === "status") {
        const account = url.searchParams.get("account") ?? "";
        const s = account ? await getSub(account) : null;
        return Response.json({ ready: mailReady(), subscribed: !!s, confirmed: !!s?.confirmed, email: s ? maskEmail(s.email) : null });
      }
      if (request.method === "GET" && action === "confirm") {
        const s = await byToken(url.searchParams.get("token"), "confirm");
        if (!s) return page("Link not valid", "This confirmation link is old or was already replaced. Turn notifications on again from Keel.");
        s.confirmed = true;
        await saveSub(s);
        return page(
          "Notifications on",
          `Keel will email ${maskEmail(s.email)} about every company ${s.account} owns or votes on. If the confirmation email was in Spam, mark it Not spam so the alerts reach your inbox.`,
        );
      }
      if (request.method === "GET" && action === "unsubscribe") {
        const s = await byToken(url.searchParams.get("token"), "unsubscribe");
        if (!s) return page("Already off", "These notifications are already off.");
        await Promise.all([removeJson(`subs/${s.account}.json`), removeJson(tokenPath(s.confirmToken)), removeJson(tokenPath(s.unsubToken))]);
        return page("Notifications off", `Keel no longer emails about ${s.account}, and the address was deleted.`);
      }
      if (request.method !== "POST") return fail(405, "Unknown action.");

      const origin = request.headers.get("origin");
      if (action !== "run" && origin && new URL(origin).host !== url.host) return fail(403, "Not allowed from another site.");
      const raw = await request.text();
      if (raw.length > 100_000) return fail(413, "Too large.");
      if (action === "run") {
        if (!(await verifyAgent(raw, request.headers.get("x-keel-signature")))) return fail(401, "Only Keel's agent may report a round.");
        const body = JSON.parse(raw) as { at?: number; events?: AgentEvent[] };
        if (typeof body.at !== "number" || Math.abs(Date.now() - body.at) > 10 * 60_000) return fail(400, "Stale report.");
        if (!mailReady()) return fail(503, "Email is not set up on this deployment.");
        return await run(Array.isArray(body.events) ? body.events.slice(0, 500) : []);
      }
      const body = JSON.parse(raw) as SignedRequest;
      if (action === "subscribe") {
        if (!mailReady()) return fail(503, "Email is not set up on this deployment yet.");
        return await subscribe(body);
      }
      if (action === "test") return await test(body);
      return fail(404, "Unknown action.");
    } catch (e) {
      return fail(400, e instanceof Error ? e.message.slice(0, 200) : "Something went wrong.");
    }
  },
};
