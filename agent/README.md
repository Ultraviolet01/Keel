# Keel agent

The service that runs Keel's loop for every founder's vault: observe, forecast, check, decide, act, learn. It signs as each vault with Keel's agent key, which the factory put on every vault and which can only call `execute_payment` and `propose_payment`. The vault re-checks every limit on chain.

## Run it

1. Run `npm install` in this folder.
2. Run `npm run agent -- --once --dry-run`. You see one line per step for every vault on `keel.testnet`: balance, forecast, and what Keel would do with each bill, with nothing signed. Vaults created before the agent key moved onto the vault (`kora`, `lumen`) are skipped. No key or `.env` is needed for a dry run.
3. To sign, Keel's agent key file must exist (`node ../scripts/new-agent-key.mjs` creates one; path in `AGENT_KEY_FILE`, default `~/.near-credentials/keel-agent-key.json`). Only Keel's operator holds the key that the factory puts on every vault. Without it, any run that would sign stops and suggests `--dry-run`.
4. Run `npm run agent` to keep it running, one round every 5 minutes. Options: `--once`, `--dry-run`, `--vault <id>`, `--interval <seconds>`, `--lookahead <days>`.

## Demo: one full loop in a few seconds

Anyone can run `npm run demo -- --dry-run` to see the decisions below without signing. The steps here are for Keel's operator, who holds the agent key.

1. Prepare the vault once: `OWNER=keel-owner.testnet VAULT=beacon.keel.testnet ../scripts/setup-demo-testnet.sh`. You see the demo payees created and the policy set (5 per payment, 25 per day, Northwind and Payroll allowed, the scam account blocked). Then fund the vault with about 20 to 25 of Circle's testnet USDC at https://faucet.circle.com ("Near Testnet").
2. Run `npm run demo`. You see, for the six bills in `../config/bills.json`:
   - **Northwind Hosting, 4.00**: paid alone, with a transaction link.
   - **Atlas Freight, 6.60**: proposed for the owner, because Atlas is not on the allowlist.
   - **"URGENT: supplier changed bank details", 47.50**: refused before signing, because the payee is on the blocklist. This is the prompt-injection case: the bill's text asks for urgency, the rules do not care.
   - **Contractor payroll, 12.50**: proposed, because it is over the 5 per-payment cap.
   - **Lisbon contractor, 1.20 USDC on Arbitrum**: proposed as a Chain Signatures transfer once the vault's Arbitrum Sepolia address (`0xf9fe3056ffc0f2e04f8a18bdcb877e979b5ce510`) holds the USDC and some ETH for gas; until then Keel says what is missing and waits.
   - **Porto designer, 0.50 USDC on Optimism**: the same, from the vault's Optimism Sepolia address (the same `0xf9fe…e510`).
3. Open the app's Approvals page for the vault. You see the two proposals waiting, with Keel's reasons.
4. Run `npm run demo` again. You see Keel report Northwind as already paid by the vault and Atlas and payroll as already proposed, and nothing is signed. The vault pays each bill once, so a fresh demo needs a fresh vault.

## Stress suites

`stress/live.ts` (`npm run stress`) and `stress/spam.ts` (`npm run stress:flood`) attack a throwaway vault with the agent key, the owner's key and an outsider's key. They need those keys and spend testnet NEAR, so only Keel's operator runs them. Results are in the root README under Security.

## How it decides

All decisions are plain code in `src/brain.ts`, tested in `src/brain.test.ts` and `src/fuzz.test.ts` (`npm test`, 22 tests, about 37,000 generated cases):

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

A bill with `"chain"` set in `config/bills.json` (`"base"`, `"eth"`, `"arb"`, `"op"`, `"sol"` and any other chain 1Click lists; optionally `"token": "USDT"`) is paid on that chain. Keel tries each route in order and uses the first that works, so one service being down does not stop the bill:

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
