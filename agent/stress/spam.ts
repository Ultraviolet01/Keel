// Proposal flood: a stolen agent key files maximum-size proposals until the
// vault refuses. Then checks the owner can still act.
//   STRESS_VAULT=stress.keel.testnet STRESS_OWNER=vega-founder.testnet npx tsx stress/spam.ts [max]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Account, JsonRpcProvider } from "near-api-js";
import { loadConfig } from "../src/chain";

const VAULT = process.env.STRESS_VAULT ?? "stress.keel.testnet";
const OWNER = process.env.STRESS_OWNER ?? "vega-founder.testnet";
const max = Number(process.argv[2] ?? 400);
const cfg = loadConfig();
const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
const agent = new Account(VAULT, provider, JSON.parse(readFileSync(cfg.agentKeyFile, "utf8")).private_key);
const owner = new Account(OWNER, provider, JSON.parse(readFileSync(`${homedir()}/.near-credentials/testnet/${OWNER}.json`, "utf8")).private_key);

async function free() {
  const a = (await provider.query({ request_type: "view_account", finality: "final", account_id: VAULT })) as unknown as { amount: string; storage_usage: number };
  return Number(BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n) / 1e24;
}
async function call(acc: Account, method: string, args: object, deposit = 0n) {
  try {
    const r = await acc.callFunctionRaw({ contractId: VAULT, methodName: method, args, gas: 100_000_000_000_000n, deposit, waitUntil: "EXECUTED_OPTIMISTIC" });
    const st = (r as { status?: { Failure?: unknown; SuccessValue?: string } }).status;
    if (st?.Failure) return { ok: false, error: JSON.stringify(st.Failure) };
    return { ok: true, error: "", value: st?.SuccessValue ? JSON.parse(Buffer.from(st.SuccessValue, "base64").toString()) : null };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
const run = Date.now().toString(36);
const start = await free();
console.log(`free NEAR before: ${start.toFixed(4)}`);
let n = 0;
let stop = "";
for (; n < max; n++) {
  const r = await call(agent, "propose_payment", { receiver_id: "a".repeat(20) + ".testnet", amount: "1", memo: "m".repeat(280), reason: "r".repeat(280), bill_ref: `${run}-${n}`.padEnd(64, "x") });
  if (!r.ok) { stop = r.error.match(/Keel Vault refused: [^"\\]+|LackBalanceForState[^"\\]{0,80}|[^"\\]{0,120}/)?.[0] ?? r.error; break; }
  if (n % 25 === 0) console.log(`  ${n} proposals, free NEAR ${(await free()).toFixed(4)}`);
}
const end = await free();
console.log(`stopped after ${n} proposals: ${stop || "hit the limit of this run"}`);
console.log(`free NEAR after: ${end.toFixed(4)} (${((start - end) / Math.max(n, 1) * 1000).toFixed(2)} mNEAR per proposal)`);
const w = await call(owner, "withdraw", { receiver_id: OWNER, amount: "1000000" }, 1n);
const pz = await call(owner, "pause", {}, 1n);
await call(owner, "resume", {}, 1n);
console.log(`owner withdraw after the flood: ${w.ok ? "ok" : w.error.slice(0, 160)}`);
console.log(`owner pause after the flood: ${pz.ok ? "ok" : pz.error.slice(0, 160)}`);
