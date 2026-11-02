# Keel agent

The service that runs Keel's loop for every founder's vault: observe, forecast, check, decide, act, learn. It signs as each vault with Keel's agent key, which the factory put on every vault and which can only call `execute_payment` and `propose_payment`. The vault re-checks every limit on chain.

## Run it

1. Run `npm install` in this folder.
2. Make sure Keel's agent key file exists (`node ../scripts/new-agent-key.mjs`; path in `AGENT_KEY_FILE`, default `~/.near-credentials/keel-agent-key.json`).
3. Run `npm run agent -- --once --dry-run`. You see one line per step for every vault on `keel.testnet`: balance, forecast, and what Keel would do with each bill, with nothing signed.
4. Run `npm run agent` to keep it running, one round every 5 minutes. Options: `--once`, `--dry-run`, `--vault <id>`, `--interval <seconds>`, `--lookahead <days>`.

## Demo: one full loop in a few seconds

1. Prepare the vault once: `OWNER=keel-owner.testnet VAULT=nova.keel.testnet ../scripts/setup-demo-testnet.sh`. You see the demo payees created, the policy set (100 per payment, 500 per day, Northwind and Payroll allowed, the scam account blocked) and 1,000 test USDC minted to the vault.
2. Run `npm run demo`. You see, for the four bills in `../config/bills.json`:
   - **Northwind Hosting, 80**: paid alone, with a transaction link.
   - **Atlas Freight, 132**: proposed for the owner, because Atlas is not on the allowlist.
   - **"URGENT: supplier changed bank details", 950**: refused before signing, because the payee is on the blocklist. This is the prompt-injection case: the bill's text asks for urgency, the rules do not care.
   - **Contractor payroll, 450**: proposed, because it is over the 100 per-payment cap.
3. Open the app's Approvals page for the vault. You see the two proposals waiting, with Keel's reasons.

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
