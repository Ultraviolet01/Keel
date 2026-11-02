// npm run demo: one full Keel loop on one vault, told step by step.
//
//   npm run demo                       uses DEMO_VAULT (default harbor.keel.testnet)
//   npm run demo -- --dry-run          decide everything, sign nothing
//
// Set the vault up first with scripts/setup-demo-testnet.sh.

import { Chain, loadConfig } from "./chain";
import { loadState, runVault, saveState, type Event } from "./loop";

const args = process.argv.slice(2);
const cfg = loadConfig();
const chain = new Chain(cfg);
const vault = process.env.DEMO_VAULT || "harbor.keel.testnet";
const dryRun = args.includes("--dry-run");
const started = Date.now();

const TITLES: Record<string, string> = {
  observe: "1. Observe",
  forecast: "2. Forecast",
  check: "3. Check",
  decide: "4. Decide",
  act: "5. Act",
  learn: "6. Learn",
  error: "Error",
};
let lastStep = "";

const say = (e: Event) => {
  if (e.step !== lastStep && !(e.step === "act" && lastStep === "check") && !(e.step === "check" && lastStep === "act")) {
    console.log(`\n${TITLES[e.step] ?? e.step}`);
  }
  lastStep = e.step;
  console.log(`   ${e.text}`);
  if (e.tx) console.log(`   ${cfg.explorerTx}${e.tx}`);
};

console.log(`Keel demo on ${vault} (${cfg.network})${dryRun ? ", dry run: nothing is signed" : ""}`);
const state = loadState();
delete state.handled[vault]; // replay every bill in the demo
await runVault(cfg, chain, vault, state, { dryRun, today: new Date().toISOString().slice(0, 10), lookaheadDays: 14, say });
saveState(state);

const pending = (await chain.proposals(vault)).filter((p) => p.status === "pending").length;
console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)} s. ${pending} proposals wait for the owner in the app's Approvals page.`);
