# Keel agent

The service that runs Keel's loop for every founder's vault: observe, forecast, check, decide, act, learn. It signs as each vault with Keel's agent key, which the factory put on every vault and which can only call `execute_payment` and `propose_payment`. The vault re-checks every limit on chain.

## Run it

1. Run `npm install` in this folder.
2. Make sure Keel's agent key file exists (`node ../scripts/new-agent-key.mjs`; path in `AGENT_KEY_FILE`, default `~/.near-credentials/keel-agent-key.json`).
3. Run `npm run agent -- --once --dry-run`. You see one line per step for every vault on `keel.testnet`: balance, forecast, and what Keel would do with each bill, with nothing signed.
4. Run `npm run agent` to keep it running, one round every 5 minutes. Options: `--once`, `--dry-run`, `--vault <id>`, `--interval <seconds>`, `--lookahead <days>`.

## Demo: one full loop in a few seconds

1. Prepare the vault once: `OWNER=keel-owner.testnet VAULT=harbor.keel.testnet ../scripts/setup-demo-testnet.sh`. You see the demo payees created, the policy set (100 per payment, 500 per day, Northwind and Payroll allowed, the scam account blocked) and 1,000 test USDC minted to the vault.
2. Run `npm run demo`. You see, for the four bills in `../config/bills.json`:
   - **Northwind Hosting, 80**: paid alone, with a transaction link.
   - **Atlas Freight, 132**: proposed for the owner, because Atlas is not on the allowlist.
   - **"URGENT: supplier changed bank details", 950**: refused before signing, because the payee is on the blocklist. This is the prompt-injection case: the bill's text asks for urgency, the rules do not care.
   - **Contractor payroll, 450**: proposed, because it is over the 100 per-payment cap.
3. Open the app's Approvals page for the vault. You see the two proposals waiting, with Keel's reasons.
4. Run `npm run demo` again. You see Keel report Northwind as already paid by the vault and Atlas and payroll as already proposed, and nothing is signed. The vault pays each bill once, so a fresh demo needs a fresh vault.

## How it decides

All decisions are plain code in `src/brain.ts`, tested in `src/brain.test.ts` (`npm test`, 12 tests):

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

A bill with `"chain": "base"` in `config/bills.json` is paid on Base. Keel tries each route in order and uses the first that works, so one service being down does not stop the bill:

1. **NEAR Intents 1Click** (mainnet only). Keel proposes paying a quote's deposit address.
2. **NEAR Chain Signatures** (testnet and mainnet). Keel proposes a USDC transfer from the vault's own Base address. The vault builds and hashes that transfer itself, and NEAR's MPC network signs it after the owner approves. No outside server is involved.

If no route works, Keel records nothing and tries again on the next run. Offers that expire before the owner approves are proposed again.

**Try the fallback:** run `npm run agent -- --once --dry-run --vault vega.keel.testnet`. You see the Base bill skip 1Click (`runs on mainnet only`) and fall back to Chain Signatures. Until someone funds the vault's Base Sepolia address, the result is `holds 0 USDC, needs 25 USDC; top it up`.

**After the owner approves**, the vault stores the signed transaction (`evm_signed.raw_tx`, `evm_signed.tx_hash`). On its next run Keel broadcasts it on Base and follows the receipt until it lands.

### NEAR Intents 1Click

`src/intents.ts` talks to the 1Click API: token list, quotes, deposit and status. 1Click runs on mainnet only.

1. Run `npm run intents -- tokens USDC`. You see USDC on every chain 1Click supports, with its `assetId`.
2. Run `npm run intents -- quote --to base --amount 5`. You see a dry quote (nothing is sent): how much USDC arrives on Base, the minimum, and the time estimate.
3. Run `npm run intents -- status <depositAddress>` to follow a real move until `SUCCESS`, `REFUNDED` or `FAILED`.

A real quote's deposit address expires at the quote's `deadline`, and 1Click warns that funds sent after it may be lost. So Keel files the move as a proposal with `valid_until_ms` set to that deadline, and the vault refuses to approve it once it has passed (tests `expired_intents_offer_is_never_paid` and `intents_offer_can_be_approved_before_it_expires`). Requests without `ONECLICK_JWT` pay an extra 0.25% (the hackathon FAQ says 0.2%).
