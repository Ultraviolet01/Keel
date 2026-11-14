import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { base58, base64 } from "@scure/base";
import { alertSubject, companyTitle, defang, digestLines, recipients, renderEmail, vaultAlerts, type Snapshot, type VaultState } from "./_alerts.js";
import { nep413Hash, RECIPIENT, verifySigned } from "./_notify.js";

const U = 1_000_000n;
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  vault: "acme.keel.testnet",
  policy: { owner_id: "founder.testnet", paused: false, min_balance: (10n * U).toString(), pending_owner: null },
  proposals: [],
  dao: [],
  voters: null,
  balance: 50n * U,
  decimals: 6,
  symbol: "USDC",
  events: [],
  ...over,
});
const seen: VaultState = { lastProposal: 1, daoSeen: [], paused: false, pendingOwner: null, belowBuffer: false, sent: [] };

test("first sight records where things stand and sends nothing", () => {
  const { alerts, next } = vaultAlerts(
    snap({ proposals: [{ id: 3, receiver_id: "atlas.testnet", amount: "1", reason: "new payee", status: "pending" }], events: [{ vault: "acme.keel.testnet", kind: "refused", text: "x", key: "k1" }] }),
    null,
  );
  assert.equal(alerts.length, 0);
  assert.equal(next.lastProposal, 3);
  assert.deepEqual(next.sent, ["k1"]);
});

test("a new pending proposal asks for approval once", () => {
  const s = snap({ proposals: [{ id: 2, receiver_id: "atlas.testnet", amount: (132n * U).toString(), reason: "Atlas is not an approved payee.", status: "pending" }] });
  const first = vaultAlerts(s, seen);
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].title, "Approval needed: 132.00 USDC to atlas.testnet");
  assert.equal(vaultAlerts(s, first.next).alerts.length, 0, "not again on the next round");
});

test("a multisig vote goes only to voters who have not voted", () => {
  const s = snap({ voters: ["a.testnet", "b.testnet"], dao: [{ id: 7, proposer: "a.testnet", votes: { "a.testnet": "Approve" }, methods: ["add_payee"] }] });
  const { alerts } = vaultAlerts(s, seen);
  assert.equal(alerts.length, 1);
  assert.deepEqual(recipients(alerts[0], "team.sputnikv2.testnet", ["a.testnet", "b.testnet"]), ["b.testnet"]);
});

test("proposals filed by outsiders are not emailed; the digest counts them", () => {
  const dao = [
    { id: 8, proposer: "spammer.testnet", votes: {}, methods: ["withdraw"] },
    { id: 9, proposer: "b.testnet", votes: {}, methods: ["add_payee"] },
  ];
  const { alerts } = vaultAlerts(snap({ voters: ["a.testnet", "b.testnet"], members: ["a.testnet", "b.testnet"], dao }), seen);
  assert.deepEqual(alerts.map((a) => a.title), ["Vote needed: multisig proposal #9"]);
  const lines = digestLines([], 0, 6, "USDC", {}, 0, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^1 open multisig proposal filed by accounts outside the team/);
});

test("pause, ownership offer and falling below the buffer each alert once", () => {
  const s = snap({ policy: { owner_id: "founder.testnet", paused: true, min_balance: (10n * U).toString(), pending_owner: "team.sputnikv2.testnet" }, balance: 5n * U });
  const first = vaultAlerts(s, seen);
  assert.deepEqual(first.alerts.map((a) => a.title), ["Payments paused", "Ownership offered to team.sputnikv2.testnet", "Cash below the buffer"]);
  assert.equal(vaultAlerts(s, first.next).alerts.length, 0);
});

test("agent events are emailed once per key", () => {
  const ev = { vault: "acme.keel.testnet", kind: "refused" as const, text: "refuse, nothing signed: the payee is blocklisted", key: "acme:refused:scam" };
  const first = vaultAlerts(snap({ events: [ev] }), seen);
  assert.equal(first.alerts[0].title, "Keel refused a bill");
  assert.equal(vaultAlerts(snap({ events: [ev] }), first.next).alerts.length, 0);
});

test("everyone alerts go to the owner, or to every member of its multisig", () => {
  const a = { vault: "v", who: "everyone" as const, title: "t", detail: "d" };
  assert.deepEqual(recipients(a, "founder.testnet", null), ["founder.testnet"]);
  assert.deepEqual(recipients(a, "team", ["a", "b"]), ["a", "b"]);
});

test("digest: transfers after the last digest, oldest first, with payee names", () => {
  const lines = digestLines(
    [
      { at: 300, delta: -4n * U, counterparty: "payroll.testnet" },
      { at: 100, delta: 9n * U, counterparty: "old.testnet" },
      { at: 200, delta: 10n * U, counterparty: "founder.testnet" },
    ],
    150,
    6,
    "USDC",
    { "payroll.testnet": "Payroll" },
    1,
  );
  assert.deepEqual(lines, ["Received 10.00 USDC from founder.testnet", "Paid 4.00 USDC to Payroll", "1 payment still waiting for approval"]);
  assert.deepEqual(digestLines([], 0, 6, "USDC", {}, 3), [], "no digest when nothing moved");
});

test("email html escapes text from the chain", () => {
  const { html } = renderEmail({ heading: "<b>x</b>", sections: [{ title: "v", lines: ['<script>alert("x")</script>'] }], link: "https://k", linkText: "Open" });
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

// A message signed by near-api-js's own NEP-413 signer (a throwaway test key, no real account).
const VECTOR = {
  accountId: "alice.testnet",
  publicKey: "ed25519:6DSjZ8mvsRZDvFqFxo8tCKePG96omXW7eVYVSySmDk8e",
  signature: "MeX6E+V+5SdS22zwk95ppHxDZKSIejL2GVkukLbsoe5ObHEcAXcCKCGWRjrgDCDDLTwl22JL1aliJF2BzF6mAQ==",
  message: "Keel notifications\nAccount: alice.testnet\nAction: subscribe\nEmail: alice@example.com\nTime: 2026-11-09T12:00:00.000Z",
  nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
};
const at = Date.parse("2026-11-09T12:01:00Z");

test("NEP-413: our hash matches what near-api-js signs", () => {
  const ok = ed25519.verify(base64.decode(VECTOR.signature), nep413Hash(VECTOR.message, base64.decode(VECTOR.nonce), RECIPIENT), base58.decode(VECTOR.publicKey.slice(8)));
  assert.ok(ok);
});

test("NEP-413: a changed message, another account, another action or an old message is refused", async () => {
  await assert.rejects(verifySigned({ ...VECTOR, message: VECTOR.message.replace("alice@", "mallory@") }, "subscribe", at), /does not match/);
  await assert.rejects(verifySigned({ ...VECTOR, accountId: "bob.testnet" }, "subscribe", at), /another account/);
  await assert.rejects(verifySigned(VECTOR, "test", at), /something else/);
  await assert.rejects(verifySigned(VECTOR, "subscribe", at + 3_600_000), /too old/);
});

test("emails name the company: in the subject and each section", () => {
  assert.equal(companyTitle("compass.keel.testnet"), "Compass (compass.keel.testnet)");
  assert.equal(alertSubject([{ vault: "compass.keel.testnet", title: "Payments paused" }]), "Keel · Compass: Payments paused");
  assert.equal(
    alertSubject([
      { vault: "compass.keel.testnet", title: "a" },
      { vault: "harvest.keel.testnet", title: "b" },
      { vault: "compass.keel.testnet", title: "c" },
    ]),
    "Keel: 3 things need you in Compass, Harvest",
  );
});

test("web addresses a payee wrote are never clickable in a Keel email; NEAR accounts and Keel's own link stay", () => {
  const line = 'Keel\'s reason: Pay 9.00 USDC to atlas.testnet. Invoice text (unverified): "confirm at https://keel-verify.example.com/login, www.keel-login.com or keel-support.net, HTTP : // x.io"';
  const r = renderEmail({ heading: "h", sections: [{ title: "Acme", lines: [line] }], link: "https://keel-treasury.vercel.app/app", linkText: "Open Keel" });
  for (const body of [r.text, r.html]) {
    assert.doesNotMatch(body, /https:\/\/keel-verify|www\.keel-login|keel-support\.net|x\.io/i);
    assert.match(body, /atlas\.testnet/);
  }
  assert.match(r.html, /href="https:\/\/keel-treasury\.vercel\.app\/app"/);
  assert.equal(defang("Pay 2.00 USDC to northwind-keel.testnet, due 2026-11-26"), "Pay 2.00 USDC to northwind-keel.testnet, due 2026-11-26");
});

test("defang covers any domain ending and lookalike dots", () => {
  for (const t of ["keel-login.finance", "keel-pay.rocks/verify", "keel\uff0elogin\uff0ecom", "keel-login\u3002com", "keel-verify.pw", "a.b.c.d.example"]) assert.doesNotMatch(defang(t), /[a-z0-9-]\.[a-z]/i, t);
  for (const t of ["northwind-keel.testnet", "keel.near", "berth.keel.testnet", "2.00 USDC", "Invoice 3107"]) assert.equal(defang(t), t, t);
});
