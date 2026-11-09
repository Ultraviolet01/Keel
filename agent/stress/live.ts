// Live attack run against a throwaway Keel Vault on testnet.
//
//   STRESS_VAULT=stress.keel.testnet STRESS_OWNER=vega-founder.testnet npx tsx stress/live.ts
//
// Signs as three parties: Keel's agent key, the vault owner, and an outsider
// (atlas-keel.testnet). Every attack must be refused; every allowed action
// must work. Prints one line per check and exits non-zero if any check fails.
// Moves test USDC and spends testnet NEAR; never point it at a real vault.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Account, JsonRpcProvider } from "near-api-js";
import { Chain, loadConfig } from "../src/chain";

const VAULT = process.env.STRESS_VAULT ?? "stress.keel.testnet";
const OWNER = process.env.STRESS_OWNER ?? "vega-founder.testnet";
const OUTSIDER = "atlas-keel.testnet";
const PAYEE = "northwind-keel.testnet";
const U = 1_000_000n;

const cfg = loadConfig();
const chain = new Chain(cfg);
// The vault's own token, and its caps as they are now: the suite raises the daily cap for
// its race test and puts the caps back when it ends, so it never leaves a vault looser.
const START = await chain.policy(VAULT);
const TOKEN = START.token_id;
const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
const legacyKey = (id: string) => JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${id}.json`, "utf8")).private_key;
const agentKey = JSON.parse(readFileSync(cfg.agentKeyFile, "utf8")).private_key;

const as = {
  agent: new Account(VAULT, provider, agentKey),
  owner: new Account(OWNER, provider, legacyKey(OWNER)),
  outsider: new Account(OUTSIDER, provider, legacyKey(OUTSIDER)),
};
type Who = keyof typeof as;

let failures = 0;
const results: string[] = [];
function record(ok: boolean, name: string, detail: string) {
  if (!ok) failures++;
  const line = `${ok ? "PASS" : "FAIL"}  ${name.padEnd(62)} ${detail.slice(0, 110)}`;
  results.push(line);
  console.log(line);
}

/** Calls a vault method and returns { ok, error }. Never throws. */
async function call(who: Who, method: string, args: object, deposit = 0n, gas = 100_000_000_000_000n, contractId = VAULT) {
  try {
    const res = await as[who].callFunctionRaw({ contractId, methodName: method, args, gas, deposit, waitUntil: "EXECUTED_OPTIMISTIC" });
    const st = (res as { status?: { Failure?: unknown; SuccessValue?: string } }).status;
    // A transaction can succeed while a later receipt (the token transfer) fails.
    const receipts = (res as { receipts_outcome?: { outcome: { status: { Failure?: unknown } } }[] }).receipts_outcome ?? [];
    const inner = receipts.find((r) => r.outcome.status.Failure)?.outcome.status.Failure;
    if (st?.Failure) return { ok: false, error: JSON.stringify(st.Failure), value: null, inner: null };
    const value = st?.SuccessValue ? JSON.parse(Buffer.from(st.SuccessValue, "base64").toString() || "null") : null;
    return { ok: true, error: "", value, inner: inner ? JSON.stringify(inner) : null };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e), value: null, inner: null };
  }
}

const refused = (r: { ok: boolean; error: string }, pattern: RegExp) => !r.ok && pattern.test(r.error);
const short = (r: { ok: boolean; error: string }) => (r.ok ? "succeeded" : r.error.replace(/\s+/g, " ").match(/(Keel Vault refused: [^"\\]+|Smart contract panicked: [^"\\]+|[A-Za-z]*(Mismatch|NotFound|private)[^"\\]{0,60}|[^"\\]{0,90})/)?.[0] ?? r.error);
const bal = (id: string) => chain.balance(TOKEN, id);
const run = `s${Date.now().toString(36)}`; // unique bill refs per run

console.log(`Stress run ${run} on ${VAULT} (owner ${OWNER})\n`);

// ------------------------------------------------ 1. who may call what
for (const m of ["update_policy", "approve", "withdraw", "pause", "resume", "revoke_agent", "set_agent_key", "release_bill", "set_evm_route", "withdraw_evm"]) {
  const r = await call("agent", m, {});
  record(refused(r, /MethodNameMismatch|does not allow method|not allowed|isn't allowed/i), `agent key cannot call ${m}`, short(r));
}
{
  const r = await call("agent", "ft_transfer", { receiver_id: OUTSIDER, amount: "1" }, 0n, 30_000_000_000_000n, TOKEN);
  record(refused(r, /ReceiverMismatch|receiver|not allowed|isn't allowed/i), "agent key cannot call the token contract directly", short(r));
}
{
  const r = await call("agent", "execute_payment", { receiver_id: PAYEE, amount: String(U), bill_ref: `${run}-dep` }, 1n);
  record(!r.ok, "agent key cannot attach a deposit", short(r));
}
for (const m of ["execute_payment", "propose_payment"]) {
  const r = await call("outsider", m, { receiver_id: OUTSIDER, amount: String(U), reason: "x", bill_ref: `${run}-out` });
  record(refused(r, /only the agent/), `outsider cannot call ${m}`, short(r));
}
for (const [m, args] of [
  ["on_payment_done", { proposal_id: null, receiver_id: OUTSIDER, amount: "1", agent_day: null, bill_ref: null }],
  ["on_evm_signed", { proposal_id: 1 }],
] as const) {
  const r = await call("outsider", m, args);
  record(refused(r, /private/i), `outsider cannot call the private callback ${m}`, short(r));
}
for (const m of ["update_policy", "withdraw", "pause", "release_bill", "set_evm_route"]) {
  const r = await call("outsider", m, { update: {}, reason: "x", receiver_id: OUTSIDER, amount: "1", bill_ref: "x", chain_id: 1, route: null }, 1n);
  record(refused(r, /only the owner/), `outsider cannot call owner method ${m}`, short(r));
}
{
  const r = await call("owner", "pause", {}, 0n);
  record(refused(r, /yocto/i), "owner methods need exactly 1 yoctoNEAR (0 attached)", short(r));
}

// ------------------------------------------------ 2. the bands
{
  const r = await call("agent", "execute_payment", { receiver_id: "scam-keel.testnet", amount: String(U), bill_ref: `${run}-scam` });
  record(refused(r, /blocklist/), "agent cannot pay a blocklisted payee", short(r));
  const p = await call("agent", "propose_payment", { receiver_id: "scam-keel.testnet", amount: String(U), reason: "urgent", bill_ref: `${run}-scam2` });
  record(refused(p, /blocklist/), "agent cannot even propose to a blocklisted payee", short(p));
}
{
  const r = await call("agent", "execute_payment", { receiver_id: OUTSIDER, amount: String(U), bill_ref: `${run}-new` });
  record(refused(r, /not on the allowlist/), "agent cannot pay a new payee alone", short(r));
  const r2 = await call("agent", "execute_payment", { receiver_id: PAYEE, amount: String(101n * U), bill_ref: `${run}-big` });
  record(refused(r2, /per-payment cap/), "agent cannot pay over the per-payment cap", short(r2));
  const r3 = await call("agent", "execute_payment", { receiver_id: PAYEE, amount: "0", bill_ref: `${run}-zero` });
  record(refused(r3, /above zero/), "agent cannot pay zero", short(r3));
  const r4 = await call("agent", "execute_payment", { receiver_id: PAYEE, amount: "340282366920938463463374607431768211455", bill_ref: `${run}-max` });
  record(refused(r4, /per-payment cap/), "u128::MAX amount is refused, no overflow", short(r4));
  const r5 = await call("agent", "execute_payment", { receiver_id: PAYEE, amount: "-5", bill_ref: `${run}-neg` });
  record(!r5.ok, "negative amount is rejected", short(r5));
  const r6 = await call("agent", "execute_payment", { receiver_id: "NOT A VALID ACCOUNT!", amount: "1", bill_ref: `${run}-bad` });
  record(!r6.ok, "invalid account id is rejected", short(r6));
  const r7 = await call("agent", "propose_payment", { receiver_id: OUTSIDER, amount: String(U), reason: "x".repeat(281), bill_ref: `${run}-long` });
  record(refused(r7, /longer than 280/), "281-character reason is refused", short(r7));
  const r8 = await call("agent", "propose_payment", { receiver_id: OUTSIDER, amount: String(U), reason: "é".repeat(141), bill_ref: `${run}-utf` });
  record(refused(r8, /longer than 280/), "length is counted in bytes (141 × 'é' = 282 bytes)", short(r8));
  const r9 = await call("agent", "execute_payment", { receiver_id: PAYEE, amount: String(U), bill_ref: "x".repeat(65) });
  record(refused(r9, /bill_ref must be/), "65-character bill_ref is refused", short(r9));
}

// ------------------------------------------------ 3. daily cap under load
{
  const before = await bal(PAYEE);
  const policy = await chain.policy(VAULT);
  const room = BigInt(policy.daily_cap) - BigInt(policy.spent_today);
  const n = Number(room / (80n * U)) + 2;
  let paid = 0;
  let refusedCap = 0;
  for (let i = 0; i < n; i++) {
    const r = await call("agent", "execute_payment", { receiver_id: PAYEE, amount: String(80n * U), bill_ref: `${run}-cap-${i}` });
    if (r.ok) paid++;
    else if (/daily cap/.test(r.error)) refusedCap++;
  }
  const after = await bal(PAYEE);
  const spent = BigInt((await chain.policy(VAULT)).spent_today);
  record(spent <= BigInt(policy.daily_cap), `daily cap holds over ${n} payments in a row`, `${paid} paid, ${refusedCap} refused at the cap, spent today ${spent / U} of ${BigInt(policy.daily_cap) / U}`);
  record(after - before === BigInt(paid) * 80n * U, "token balance moved exactly by the payments that passed", `payee +${(after - before) / U}`);
}

// ------------------------------------------------ 4. the same bill twice, in parallel
{
  const policyNow = await chain.policy(VAULT);
  // The cap may be used up by section 3; the owner raises it for this part.
  await call("owner", "update_policy", { update: { daily_cap: String(BigInt(policyNow.spent_today) + 1000n * U) }, reason: "stress: room for the race test" }, 1n);
  const ref = `${run}-race`;
  const before = await bal(PAYEE);
  // Two agent processes, two keys? No: one key. Different nonces are assigned by near-api-js per call, so fire them together.
  const rs = await Promise.all([1, 2, 3, 4].map(() => call("agent", "execute_payment", { receiver_id: PAYEE, amount: String(10n * U), bill_ref: ref })));
  const ok = rs.filter((r) => r.ok).length;
  const after = await bal(PAYEE);
  record(ok <= 1 && after - before <= 10n * U, "4 parallel payments of one bill pay it at most once", `${ok} succeeded; payee +${(after - before) / U}; others: ${[...new Set(rs.filter((r) => !r.ok).map(short))].join(" / ")}`);
}

// ------------------------------------------------ 5. proposals: approve twice, reject then approve, supersede
{
  const a = await call("agent", "propose_payment", { receiver_id: OUTSIDER, amount: String(5n * U), reason: "stress A", bill_ref: `${run}-pa` });
  const id = a.value as number;
  const first = await call("owner", "approve", { proposal_id: id }, 1n);
  const second = await call("owner", "approve", { proposal_id: id }, 1n);
  record(first.ok && refused(second, /not pending/), "a proposal can be approved only once", `first ${first.ok ? "ok" : short(first)}, second: ${short(second)}`);
  const b = await call("agent", "propose_payment", { receiver_id: OUTSIDER, amount: String(5n * U), reason: "stress B", bill_ref: `${run}-pb` });
  await call("owner", "reject", { proposal_id: b.value }, 1n);
  const late = await call("owner", "approve", { proposal_id: b.value }, 1n);
  record(refused(late, /not pending/), "a rejected proposal cannot be approved later", short(late));
  const again = await call("agent", "propose_payment", { receiver_id: OUTSIDER, amount: String(5n * U), reason: "stress A again", bill_ref: `${run}-pa` });
  record(refused(again, /already paid/), "an approved bill cannot be proposed again", short(again));
  const c1 = await call("agent", "propose_payment", { receiver_id: OUTSIDER, amount: String(5n * U), reason: "quote 1", bill_ref: `${run}-pc` });
  const c2 = await call("agent", "propose_payment", { receiver_id: OUTSIDER, amount: String(6n * U), reason: "quote 2", bill_ref: `${run}-pc` });
  const old = await call("owner", "approve", { proposal_id: c1.value }, 1n);
  record(refused(old, /not pending|no such proposal/), "a superseded offer cannot be approved (it is deleted)", short(old));
  await call("owner", "reject", { proposal_id: c2.value }, 1n);
  const exp = await call("agent", "propose_payment", { receiver_id: OUTSIDER, amount: String(U), reason: "x", valid_until_ms: Date.now() - 1000, bill_ref: `${run}-exp` });
  record(refused(exp, /already expired/), "an offer that already expired cannot be proposed", short(exp));
  const soon = await call("agent", "propose_payment", { receiver_id: OUTSIDER, amount: String(U), reason: "x", valid_until_ms: Date.now() + 4000, bill_ref: `${run}-soon` });
  await new Promise((r) => setTimeout(r, 7000));
  const lateApprove = await call("owner", "approve", { proposal_id: soon.value }, 1n);
  record(refused(lateApprove, /offer expired/), "an offer cannot be approved after it expires", short(lateApprove));
}

// ------------------------------------------------ 6. EVM route abuse through the agent key
{
  const info = await chain.view<{ routes?: { chain_id: number; token: string }[]; route?: { token: string } }>(VAULT, "get_evm_route");
  const token = info.routes?.find((r) => r.chain_id === 84532)?.token ?? info.route!.token;
  const base = { chain_id: 84532, token, to: "0x00000000000000000000000000000000000000aa", nonce: 0, max_fee_per_gas: "1000000", max_priority_fee_per_gas: "1000000", gas_limit: 60000 };
  const tries: [string, object, string, RegExp][] = [
    ["a chain the vault has no route for", { ...base, chain_id: 1 }, base.to, /chain is not/],
    ["Base's USDC on the Arbitrum route", { ...base, chain_id: 421614 }, base.to, /route's token/],
    ["another token", { ...base, token: "0x00000000000000000000000000000000000000bb" }, base.to, /route's token/],
    ["a huge fee", { ...base, max_fee_per_gas: "999000000000" }, base.to, /fee over/],
    ["a huge gas limit", { ...base, gas_limit: 10_000_000 }, base.to, /gas limit over/],
    ["priority fee above max fee", { ...base, max_priority_fee_per_gas: "2000000" }, base.to, /priority fee/],
    ["receiver_id that differs from evm.to", base, PAYEE, /receiver_id must be/],
    ["a malformed 0x address", { ...base, to: "0x1234" }, "0x1234", /0x address/],
  ];
  for (const [name, evm, receiver, pattern] of tries) {
    const r = await call("agent", "propose_payment", { receiver_id: receiver, amount: String(U), reason: "x", evm, bill_ref: `${run}-evm-${name.length}` });
    record(refused(r, pattern), `EVM proposal with ${name} is refused`, short(r));
  }
}

// ------------------------------------------------ 7. kill switch and firing the agent
{
  await call("owner", "pause", {}, 1n);
  const p1 = await call("agent", "execute_payment", { receiver_id: PAYEE, amount: String(U), bill_ref: `${run}-paused` });
  const p2 = await call("agent", "propose_payment", { receiver_id: OUTSIDER, amount: String(U), reason: "x", bill_ref: `${run}-paused2` });
  const w = await call("owner", "withdraw", { receiver_id: OWNER, amount: String(U) }, 1n);
  await call("owner", "resume", {}, 1n);
  record(refused(p1, /paused/) && refused(p2, /paused/), "pause stops payments and proposals", `${short(p1)} / ${short(p2)}`);
  record(w.ok && !w.inner, "the owner can still withdraw while paused", w.ok ? (w.inner ? `inner failure ${w.inner.slice(0, 60)}` : "ok") : short(w));

  const rv = await call("owner", "revoke_agent", {}, 1n);
  const dead = await call("agent", "propose_payment", { receiver_id: OUTSIDER, amount: String(U), reason: "x", bill_ref: `${run}-fired` });
  const pk = (await chain.policy(VAULT)).agent_key;
  await call("owner", "set_agent_key", { agent_key: await chain.agentPublicKey() }, 1n);
  let back = await call("agent", "propose_payment", { receiver_id: OUTSIDER, amount: String(U), reason: "rehired", bill_ref: `${run}-rehired` });
  if (!back.ok) console.log("   rehired call 1:", back.error.slice(0, 300));
  record(rv.ok && !dead.ok && pk === null && back.ok, "revoked agent can do nothing; rehired agent works again", `revoke ${rv.ok ? "ok" : short(rv)}; fired call: ${short(dead).slice(0, 50)}; rehired ${back.ok ? "ok" : short(back)}`);
  if (back.ok) await call("owner", "reject", { proposal_id: back.value }, 1n);
}

{
  const now = await chain.policy(VAULT);
  if (now.daily_cap !== START.daily_cap || now.per_payment_cap !== START.per_payment_cap) {
    const back = await call("owner", "update_policy", { update: { daily_cap: START.daily_cap, per_payment_cap: START.per_payment_cap }, reason: "stress: restore the caps the run started with" }, 1n);
    record(back.ok, "caps are restored after the run", back.ok ? `daily ${BigInt(START.daily_cap) / U}, per payment ${BigInt(START.per_payment_cap) / U}` : short(back));
  }
}

console.log(`\n${results.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
