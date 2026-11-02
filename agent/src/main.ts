// Keel's agent service.
//
//   npm run agent                     every vault, every 5 minutes
//   npm run agent -- --once           one round, then exit
//   npm run agent -- --dry-run        decide but sign nothing
//   npm run agent -- --vault anchor.keel.testnet --once

import { Chain, loadConfig } from "./chain";
import { loadState, runVault, saveState, type Event } from "./loop";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const cfg = loadConfig();
const chain = new Chain(cfg);
const once = flag("once");
const dryRun = flag("dry-run");
const onlyVault = value("vault");
const intervalSec = Number(value("interval") ?? 300);
const lookaheadDays = Number(value("lookahead") ?? 3);

const say = (e: Event) => {
  const link = e.tx ? `  ${cfg.explorerTx}${e.tx}` : "";
  console.log(`${new Date().toISOString().slice(11, 19)}  ${e.vault.padEnd(26)} ${e.step.padEnd(9)} ${e.text}${link}`);
};

async function round() {
  const state = loadState();
  const vaults = onlyVault ? [onlyVault] : await chain.vaults();
  const today = value("today") ?? new Date().toISOString().slice(0, 10);
  for (const v of vaults) {
    try {
      await runVault(cfg, chain, v, state, { dryRun, today, lookaheadDays, say });
    } catch (e) {
      say({ vault: v, step: "error", text: String(e).slice(0, 200) });
    }
  }
  saveState(state);
}

if (!dryRun && !chain.canSign()) {
  console.error(`Signing needs Keel's agent key file (${cfg.agentKeyFile}), which only Keel's operator has. Add --dry-run to see every decision without signing.`);
  process.exit(1);
}
console.log(`Keel agent on ${cfg.network}, factory ${cfg.factoryId}, agent key ${(await chain.agentPublicKey()).slice(0, 16)}…${dryRun ? ", dry run" : ""}`);
await round();
if (!once) {
  setInterval(() => round().catch((e) => console.error(e)), intervalSec * 1000);
}
