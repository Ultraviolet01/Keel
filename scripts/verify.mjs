#!/usr/bin/env node
// npm run verify: every check a reviewer can run without Keel's keys, with one
// PASS/FAIL/SKIP line each and a final summary. Exits 1 if anything fails.
//
//   npm run verify            all checks (installs agent/ and web/ dependencies if missing)
//   npm run verify -- --quick skip the Rust contract tests and the app build
//
// Needs Node 22+. Rust (cargo) is optional: without it the contract tests are
// skipped, not failed. Network checks read NEAR testnet and four EVM testnets.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUICK = process.argv.includes("--quick");
const results = [];

// --------------------------------------------------------------- helpers

function run(cmd, args, cwd, timeoutMs = 600_000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env, shell: process.platform === "win32" });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
  });
}

const has = async (cmd) => (await run(cmd, ["--version"], ROOT, 20_000)).code === 0;

async function check(name, fn) {
  const t0 = Date.now();
  let status = "PASS";
  let detail = "";
  try {
    const r = await fn();
    if (r && typeof r === "object") ({ status = "PASS", detail = "" } = r);
    else detail = r ?? "";
  } catch (e) {
    status = "FAIL";
    detail = String(e instanceof Error ? e.message : e).replace(/\s+/g, " ").slice(0, 160);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push({ name, status, detail });
  console.log(`${status.padEnd(4)}  ${name.padEnd(52)} ${`${secs}s`.padStart(6)}  ${detail}`);
}

const skip = (detail) => ({ status: "SKIP", detail });

async function needOk(cmd, args, cwd, what) {
  const r = await run(cmd, args, cwd);
  if (r.code !== 0) {
    // Name the failing tests when the output has them; otherwise show the last lines.
    const failing = [...r.out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]).filter((n) => !/^src\//.test(n));
    const why = failing.length ? `failing: ${failing.join("; ")}` : r.out.trim().split("\n").slice(-3).join(" | ");
    throw new Error(`${what} exited ${r.code}: ${why}`);
  }
  return r.out;
}

/** Node's test runner summary: "# pass 23" / "# fail 0". */
function testCounts(out) {
  const pass = Number(out.match(/^# pass (\d+)/m)?.[1] ?? NaN);
  const fail = Number(out.match(/^# fail (\d+)/m)?.[1] ?? NaN);
  const skipped = Number(out.match(/^# skipped (\d+)/m)?.[1] ?? 0);
  if (Number.isNaN(pass)) throw new Error("no test summary in the output");
  if (fail > 0) throw new Error(`${fail} failed, ${pass} passed`);
  return `${pass} passed${skipped ? `, ${skipped} skipped` : ""}`;
}

async function json(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  return res.json();
}

const NEAR_RPC = "https://test.rpc.fastnear.com";
async function nearView(account, method, args = {}) {
  const r = await json(NEAR_RPC, {
    jsonrpc: "2.0",
    id: 1,
    method: "query",
    params: { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
  });
  if (!r.result?.result) throw new Error(`${account}.${method}: ${JSON.stringify(r.error ?? r).slice(0, 120)}`);
  return JSON.parse(Buffer.from(r.result.result).toString());
}

// --------------------------------------------------------------- checks

console.log(`Keel verify${QUICK ? " (quick)" : ""}: ${new Date().toISOString()}\n`);

await check("Node.js 22 or newer", async () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error(`found ${process.versions.node}`);
  return process.versions.node;
});

for (const dir of ["agent", "web"]) {
  await check(`${dir}: dependencies installed`, async () => {
    if (existsSync(join(ROOT, dir, "node_modules"))) return "already installed";
    await needOk("npm", ["ci", "--no-audit", "--no-fund"], join(ROOT, dir), "npm ci");
    return "installed with npm ci";
  });
}

await check("agent: typecheck (tsc, includes stress suites)", async () => {
  await needOk("npm", ["run", "-s", "typecheck"], join(ROOT, "agent"), "tsc");
  return "no type errors";
});
await check("agent: unit and generated-case tests", async () => testCounts(await needOk("npm", ["test"], join(ROOT, "agent"), "npm test")));
await check("web: typecheck", async () => {
  await needOk("npx", ["tsc", "--noEmit", "-p", "."], join(ROOT, "web"), "tsc");
  return "no type errors";
});
await check("web: 1Click deposit-check tests", async () => testCounts(await needOk("npm", ["test"], join(ROOT, "web"), "npm test")));
await check("web: production build", async () => {
  if (QUICK) return skip("--quick");
  const out = await needOk("npx", ["vite", "build"], join(ROOT, "web"), "vite build");
  return out.match(/built in [\d.]+m?s/)?.[0] ?? "built";
});

const cargo = !QUICK && (await has("cargo"));
for (const [dir, name] of [["contract", "vault contract tests (cargo)"], ["factory", "factory contract tests (cargo)"]]) {
  await check(name, async () => {
    if (QUICK) return skip("--quick");
    if (!cargo) return skip("cargo not installed; install Rust to run");
    const out = await needOk("cargo", ["test", "--quiet"], join(ROOT, dir), "cargo test");
    const m = [...out.matchAll(/test result: ok\. (\d+) passed; (\d+) failed/g)];
    const passed = m.reduce((s, x) => s + Number(x[1]), 0);
    if (!m.length) throw new Error("no cargo test result line");
    return `${passed} passed`;
  });
}

// Live, read-only checks against testnet. Nothing here signs.
await check("testnet: factory keel.testnet answers", async () => {
  const c = await nearView("keel.testnet", "get_config");
  if (!c.vault_code_hash || !c.agent_key) throw new Error("get_config is missing fields");
  return `vault_code_hash ${c.vault_code_hash.slice(0, 10)}…, agent key ${c.agent_key.slice(0, 16)}…`;
});

await check("testnet: demo dry run decides every bill", async () => {
  const out = await needOk("npm", ["run", "-s", "demo", "--", "--dry-run"], join(ROOT, "agent"), "demo --dry-run");
  if (/Error:|TypeError|ENOENT/.test(out)) throw new Error(out.match(/.*(Error|ENOENT).*/)?.[0] ?? "error in output");
  // The scam bill is refused on every run; the other bills are decided or already settled by the vault.
  if (!/refused: payee is on the vault's blocklist/.test(out)) throw new Error("the blocklisted bill was not refused");
  const decided = (out.match(/^\s+(pay|propose) \(dry run/gm) ?? []).length;
  const settled = (out.match(/already paid this bill|already proposed as #\d+/g) ?? []).length;
  if (decided + settled < 3) throw new Error(`only ${decided} decided and ${settled} settled bills`);
  return `scam bill refused; ${decided} decided, ${settled} already settled on chain`;
});

await check("testnet: cross-chain bill reaches Chain Signatures", async () => {
  const out = await needOk("npm", ["run", "-s", "agent", "--", "--once", "--dry-run", "--vault", "vega.keel.testnet"], join(ROOT, "agent"), "agent --dry-run");
  if (!/via NEAR Chain Signatures|already paid on base/.test(out)) throw new Error("no Chain Signatures decision in the output");
  if (!/NEAR Intents runs on mainnet only|Would propose paying from the vault's own/.test(out)) throw new Error("route choice not shown");
  return "1Click skipped on testnet, Chain Signatures chosen";
});

// The payments recorded in the README, checked on each chain: success, from the vault's own address.
const VAULT_EVM = "0x3d003b3d8da32261fbba854dc16188cd02436644";
const PROOFS = [
  ["Optimism Sepolia", "https://sepolia.optimism.io", "0xa7312eb69bde5c12aade691af65f96e293fa291a0c3524eb2cd2b272f33b468f"],
  ["Arbitrum Sepolia", "https://sepolia-rollup.arbitrum.io/rpc", "0x4864319fc6f117023ba00a343641c6f2eae02e573ef756dca5aa2ca16d9417d2"],
  ["Base Sepolia", "https://sepolia.base.org", "0x4df6011a6fcc8f5896c29f5cb3e773d5f8cfcda6effc02d893c051123b3fd674"],
  ["Ethereum Sepolia", "https://ethereum-sepolia-rpc.publicnode.com", "0x044b25a1517da47944215cf34177ed7c3b746a7db783799c0e9f15598c63d66e"],
];
for (const [chain, rpc, hash] of PROOFS) {
  await check(`${chain}: vault-signed USDC payment landed`, async () => {
    const r = (await json(rpc, { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] })).result;
    if (!r) throw new Error("receipt not found");
    if (r.status !== "0x1") throw new Error(`status ${r.status}`);
    if (r.from.toLowerCase() !== VAULT_EVM) throw new Error(`sent from ${r.from}, not the vault`);
    const transfer = r.logs.find((l) => l.topics[0]?.startsWith("0xddf252ad"));
    const usdc = transfer ? Number(BigInt(transfer.data)) / 1e6 : 0;
    return `block ${Number(r.blockNumber)}, ${usdc} USDC from the vault's own address`;
  });
}

// --------------------------------------------------------------- summary

const count = (s) => results.filter((r) => r.status === s).length;
const failed = count("FAIL");
console.log(`\nVERIFY ${failed ? "FAILED" : "PASSED"}: ${count("PASS")} passed, ${failed} failed, ${count("SKIP")} skipped`);
for (const r of results.filter((x) => x.status === "FAIL")) console.log(`  failed: ${r.name}: ${r.detail}`);
process.exit(failed ? 1 : 0);
