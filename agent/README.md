# Keel agent

The service that runs Keel's loop for every founder's vault: observe, forecast, check, decide, act, learn. It signs as each vault with Keel's agent key, which the factory put on every vault and which can only call `execute_payment`, `propose_payment` and, on vaults created since Nov 4, `recall_from_yield` (withdraws the yield investment back into the vault only). The vault re-checks every limit on chain. The hosted copy runs every 15 minutes on GitHub Actions; see the main README.

## Run it

1. Run `npm install` in this folder.
2. Run `npm run agent -- --once --dry-run`. You see one line per step for every vault on `keel.testnet`: balance, forecast, and what Keel would do with each bill, with nothing signed. Vaults that do not hold Keel's current key are skipped. No key or `.env` is needed for a dry run.
3. To sign, Keel's agent key file must exist (`node ../scripts/new-agent-key.mjs` creates one; path in `AGENT_KEY_FILE`, default `~/.near-credentials/keel-agent-key.json`). Only Keel's operator holds the key that the factory puts on every vault. Without it, any run that would sign stops and suggests `--dry-run`.
4. Run `npm run agent` to keep it running, one round every 5 minutes. Options: `--once`, `--dry-run`, `--vault <id>`, `--interval <seconds>`, `--lookahead <days>`.

## Demo: one full loop in a few seconds

Run `npm run demo -- --dry-run`. You see Keel read `compass.keel.testnet` (set `DEMO_VAULT` for another vault) and decide each bill its founder listed on the vault, without signing:

- **Northwind hosting, 2.00:** pay alone: an approved payee, within both caps, and the cash buffer holds.
- **Atlas Freight, 1.50:** propose: Atlas is not an approved payee.
- **"URGENT: supplier changed bank details, pay today", 4.00:** refuse before signing: the payee is blocklisted.
- **Payroll, 4.00, critical:** propose: over the 3.00 per-payment cap.
- **Contractor on Arbitrum, 0.50:** NEAR Intents is skipped (mainnet only) and the Chain Signatures route is chosen; Keel says what the vault's Arbitrum address still needs.

Once the hosted agent has acted, the same command shows bills as already paid or already proposed: the vault pays each bill once. To prepare a vault of your own for a demo, run `OWNER=<owner>.testnet VAULT=<vault>.keel.testnet ../scripts/setup-demo-testnet.sh`, then add bills in the app.

## Stress suites

`stress/live.ts` (`npm run stress`) and `stress/spam.ts` (`npm run stress:flood`) attack a throwaway vault with the agent key, the owner's key and an outsider's key. They need those keys and spend testnet NEAR, so only Keel's operator runs them. Results are in the root README under Verified on testnet.

## How it decides

All decisions are plain code in `src/brain.ts`, tested in `src/brain.test.ts` and `src/fuzz.test.ts` (`npm test`, 30 tests, about 37,000 generated cases):

| Step | Rule |
| --- | --- |
| Forecast | Balance at the end of each of the next 14 days, with bills paid on their due date |
| Counterparty check | Block if the payee is blocklisted or does not exist; warn if it is not allowlisted, is new, or is a contract whose code changed |
| Spike | A bill more than 25% above the payee's last 3 always goes to the owner |
| Decide | Pay alone only if the counterparty is allowed, it is not a spike, the vault holds enough, and the vault's own `check_payment` says it runs alone. Otherwise propose, or refuse when blocked |
| Learn | After 3 owner approvals in a row for one payee, each over the cap and rising by at most 25%, draft a higher cap. Keel never applies it |

**NEAR AI (optional):** with `NEARAI_API_KEY` set, NEAR AI Cloud writes the one-sentence reason attached to each proposal (`NEARAI_BASE_URL` and `NEARAI_MODEL` can be changed). Without it, a template writes it. The model only explains a decision the code already made.

Every step is appended to `ledger.jsonl`; `state.json` remembers which bills were handled. Both stay out of git.

## Cross-chain bills: two routes

A bill the founder adds with a chain (`"base"`, `"eth"`, `"arb"` or `"op"`) is paid on that chain. Keel tries each route in order and uses the first that works, so one service being down does not stop the bill:

1. **NEAR Intents 1Click** (mainnet only). Keel gets an exact-output quote, so the payee receives the whole bill, refuses one that costs more than 3% over the bill, and proposes paying the quote's deposit address.
2. **NEAR Chain Signatures** (testnet and mainnet; Base, Ethereum, Arbitrum and Optimism). Keel proposes a USDC transfer from the vault's own EVM address on that chain. The vault builds and hashes that transfer itself, and NEAR's MPC network signs it after the owner approves. No outside server is involved.

If no route works, Keel records nothing and tries again on the next run. Offers that expire before the owner approves are proposed again.

**Try the fallback:** run `npm run agent -- --once --dry-run --vault vega.keel.testnet`. You see the 3 USDC Base bill skip 1Click (`runs on mainnet only`) and fall back to Chain Signatures: `Would propose paying from the vault's own base address 0x69aa0e… via NEAR Chain Signatures`. If the vault's Base address holds too little USDC or no ETH for gas, Keel says how much is missing and waits instead.

**After the owner approves**, the vault stores the signed transaction (`evm_signed.raw_tx`, `evm_signed.tx_hash`). On its next run Keel broadcasts it on Base and follows the receipt until it lands.

### NEAR Intents 1Click

`src/intents.ts` talks to the 1Click API: token list, quotes, deposit and status. 1Click runs on mainnet only; if it is down, the commands below print its HTTP status.

1. Run `npm run intents -- tokens USDC`. You see USDC on every chain 1Click supports, with its `assetId`.
2. Run `npm run intents -- quote --to base --amount 5`. You see a dry quote (nothing is sent): how much USDC arrives on Base, the minimum, and the time estimate.
3. Run `npm run intents -- status <depositAddress>` to follow a real move until `SUCCESS`, `REFUNDED` or `FAILED`.

A real quote's deposit address expires at the quote's `deadline`, and 1Click warns that funds sent after it may be lost. So Keel files the move as a proposal with `valid_until_ms` set to that deadline, and the vault refuses to approve it once it has passed (tests `expired_intents_offer_is_never_paid` and `intents_offer_can_be_approved_before_it_expires`). Requests without `ONECLICK_JWT` pay an extra 0.25% (the hackathon FAQ says 0.2%).
