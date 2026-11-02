# Keel

Keel is an AI treasury agent that keeps a small company's stablecoin wallets funded. It can only move money inside limits enforced by a NEAR smart contract, the Keel Vault.

- **Who it is for:** a founder or lean finance lead with several wallets and chains and no treasury staff.
- **What it does:** reads balances and upcoming bills, forecasts 14 days ahead, and moves USDC to cover shortfalls. It pays alone under the cap and asks the owner above it.
- **What it cannot do:** spend past a cap, pay a blocklisted address, change its own rules or move NEAR. The vault refuses those calls, whatever the agent decides.

Built for NEAR HACKATHON (Nov 1–14, 2026). Tracks: Autonomous Business (`business`), AI Security & Defense (`security`), Real-World Money (`realworld`).

> Status: work in progress. Script names below are the planned ones and will be updated as the code lands.

## Try it in 10 minutes

Everything below runs on NEAR testnet and costs nothing.

**Fastest path:** after steps 1 and 2, run `npm run demo`. In under 2 minutes you see one full loop on testnet: Keel reads balances, forecasts the payroll shortfall, pays one bill alone, files one proposal, auto-approves it as the demo owner, settles it and writes every move to the ledger page. The steps below do the same thing one at a time.

1. **Install.** Run `git clone https://github.com/Ultraviolet01/keel && cd keel && npm install`. You see the install finish with no errors.
2. **Configure.** Run `cp .env.example .env` and fill in an owner and an agent testnet account. You see both account ids printed by `npm run check-env`.
3. **Sign up as a founder in the app.** Run `cd web && npm install && npm run dev`, open the address it prints and click **Connect wallet**. You see the NEAR wallet picker. Sign in with a testnet account, type your company name and click **Create**. You see your company in the sidebar with Keel's agent connected and no limits. Without a wallet, open `/?view=keel-owner.testnet` to see a founder's companies read-only. Details are in [web/README.md](web/README.md).

   **Or from the command line.** With your own testnet account, run `near contract call-function as-transaction keel.testnet create_vault json-args '{"name":"<company>"}' prepaid-gas '300 Tgas' attached-deposit '2.62 NEAR' sign-as <you>.testnet network-config testnet sign-with-legacy-keychain send`. You see `"<company>.keel.testnet"` returned: your company's own vault, owned by you, with Keel's agent key already on it and no policy. Both caps are 0 and the allowlist is empty, so every payment needs your approval. The deposit is the `min_vault_deposit` shown by `get_config` on `keel.testnet`; it pays the vault's storage and stays in the vault. Run it again with another name for each company you run; `get_vaults_for_owner` lists them all.
4. **Set your policy.** As the owner, call `update_policy` on your vault with your own caps and payees and 1 yoctoNEAR attached, for example `near contract call-function as-transaction <company>.keel.testnet update_policy json-args '{"update":{"per_payment_cap":"100000000","daily_cap":"500000000","allow":["<payee>.testnet"]},"reason":"initial policy"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <you>.testnet network-config testnet sign-with-legacy-keychain send`. You see `get_policy` return your values. The examples below assume 100 USDC per payment and 500 per day.
5. **Pay under the cap.** Run `npm run agent -- --once`. You see Keel pay Northwind Hosting 80 USDC alone, with a transaction hash and the rule it checked.
6. **Go over the cap.** Run `npm run scenario:shortfall`. You see Keel file proposal #1 to move 8,000 USDC to Payroll, with its reasons. The vault has moved nothing yet.
7. **Approve as owner.** Run `npm run approve -- 1`. You see the owner's key sign `approve(1)` and the move execute.
8. **Try the attack.** Run `npm run attack`. You see two refusals in the log: the counterparty check, then the vault.
9. **Pull the kill switch.** Run `npm run pause`, then repeat step 5. You see the vault refuse the payment until `npm run resume`.

**Export for your accountant:** run `npm run export -- --csv`, or click Export CSV on the Activity page. You see `ledger.csv` with one row per move: date (UTC), from wallet, to, amount, token, chain, fee, status (paid, pending, refunded, refused), rule checked, approved by and transaction link.

## How it works

```mermaid
flowchart LR
  S["1. Setup<br/>owner deploys vault"] --> O["2. Observe<br/>ft_balance_of, bills"]
  O --> F["3. Forecast<br/>14 days per wallet"] --> D["4. Decide<br/>transfer, swap, defer"] --> C["5. Check<br/>check_payment view"]
  C -- within limits --> A["6. Act<br/>vault or 1Click"]
  C -- outside limits --> E["9. Escalate<br/>propose, owner approves"]
  E -- approved --> A
  A --> R["7. Reconcile<br/>receipts, ledger page"] --> L["8. Learn<br/>memory, rule drafts"] --> O
  L -. rule draft .-> E
  E -. owner-approved rule update .-> S
```

A move within limits goes straight from Check to Act; anything over the threshold becomes a proposal. Blocked moves stop at Check and are logged, never proposed. Stages 2 to 8 repeat every few minutes.

## Keel Vault contract

The vault holds the USDC and the rules, and decides every payment's band itself. It deploys with no policy; the owner chooses every limit. The agent's key can call only two methods.

| Method | Who can call it | What it does |
| --- | --- | --- |
| `execute_payment` | Agent key | Pays an allowlisted payee if the amount is within the per-payment and daily caps |
| `propose_payment` | Agent key | Files a proposal for anything over the threshold, a new payee or a cross-chain swap |
| `check_payment` | Anyone (view) | Returns the band a payment would land in, without moving money |
| `approve` / `reject` | Owner key | Executes or closes a proposal |
| `update_policy` | Owner key | Changes caps, allowlist, blocklist or threshold, and logs old value, new value and reason |
| `pause` / `resume` | Owner key | Stops every payment at once, then restarts them |
| `withdraw` | Owner key | Pays out directly, for example back to the owner; works while paused |

| Band | Rule (USDC) | Result |
| --- | --- | --- |
| Runs alone | Allowlisted payee, within the owner's per-payment and daily caps (example: 100 and 500) | Vault pays, Keel logs and reconciles |
| Needs approval | Over 100, a new payee, or any cross-chain swap | Proposal waits for the owner |
| Blocked | Blocklisted payee, vault paused, or daily cap reached | Vault refuses; Keel logs it and alerts the owner |

Two token details the vault handles itself: it attaches the 1 yoctoNEAR that `ft_transfer` requires, because a function-call key cannot attach a deposit, and it registers new payees with `storage_deposit` before paying them.

Owner methods require exactly 1 yoctoNEAR attached. Function-call keys cannot attach a deposit, so only the owner's full-access key can approve, change the policy or pause.

**Check the rules yourself:** run `cd contract && cargo test`. You see 32 tests pass, one per rule, including `refuses_payment_over_cap`, `refuses_blocklisted_payee`, `agent_cannot_change_policy`, `revoked_agent_can_do_nothing` and `pause_blocks_everything_until_resume`. Method details are in [contract/README.md](contract/README.md). For the factory, run `cd factory && cargo test`: 15 tests.

## Security

The agent never holds a key that can move money freely. Limits live in the contract, so a compromised or prompt-injected agent still cannot overspend.

- **Agent key on the vault, added at sign-up:** the factory adds Keel's agent key to each new vault account in the same transaction that creates it. It is a NEAR function-call access key limited to that vault's `execute_payment` and `propose_payment`, with a 0.25 NEAR gas allowance. It cannot transfer NEAR, add keys, call `update_policy` or touch any other vault. The vault also checks that the agent key signed the call.
- **No other keys:** the vault account has no full-access key, so nobody, Keel included, can sign as the vault to move money around its rules.
- **The founder can fire the agent:** `revoke_agent` deletes the key from the vault in one transaction; `set_agent_key` adds a new one. Both need the owner's full-access key.
- **Owner key:** the founder's own wallet. Keel never holds it, and it is never stored in this repository.
- **Gas:** the agent's gas comes from the vault's own deposit, not from Keel.
- **Rule changes:** every `update_policy` call writes old value, new value, reason and approver to the public ledger page.

**Counterparty check:** before any payment, Keel scores the receiver and returns a verdict with its reasons.

| Verdict | What Keel does |
| --- | --- |
| Allow | Continues to the vault's own band check |
| Warn | Never pays alone; files a proposal with the reasons for the owner |
| Block | Refuses to sign and logs the reasons |

| Signal | Source |
| --- | --- |
| Account age and activity | Account's first transaction and recent transaction count from an RPC or indexer |
| Receiver is a contract, and its code changed recently | `view_account` code hash, compared with the last hash Keel saw |
| Prior payments from this vault | Keel's own ledger |
| Blocklist | Vault blocklist, set by the owner |

**Attack demo (`npm run attack`):**

1. A prompt-injected bill tells Keel to pay a blocklisted address.
2. Keel's counterparty check flags the address and refuses. You see refusal one in the log.
3. The script then forces the call to `execute_payment` anyway. You see the vault reject the transaction on chain, with its receipt as refusal two.

## Live on testnet

Deployed on Nov 2, 2026 with `scripts/deploy-factory-testnet.sh`. Anyone can read these, for example `near contract call-function as-read-only keel.testnet get_config json-args {} network-config testnet now`.

| Account | What it is |
| --- | --- |
| `keel.testnet` | Keel factory: creates a vault for each company a founder adds (up to 20 per founder) |
| `nova.keel.testnet` | A company vault owned by `keel-owner.testnet`, with Keel's agent key `ed25519:GZ1zQGxc…` added by the factory at sign-up; no policy set |
| `kora.keel.testnet`, `lumen.keel.testnet` | Earlier vaults for the same founder, from before the agent key moved onto the vault; they use the separate agent account `agent.keel.testnet` |
| `usdc.keel-owner.testnet` | Keel Test USDC |

Checked live:

1. **Founder signs up, agent connected automatically.** `keel-owner.testnet` called `create_vault` with `"nova"` ([transaction](https://explorer.testnet.near.org/transactions/7uK1gfQUHUbyL8e3n7KWojtNdTmpgxAQtWdMGzhV2ETw)). With no script run, `near account list-keys nova.keel.testnet network-config testnet now` shows one key: `only do ["execute_payment", "propose_payment"] function calls on nova.keel.testnet with an allowance of 0.25 NEAR`.
2. **The agent works inside the rules.** Signing with that key, the agent's payment is refused (`Keel Vault refused: new payee, not on the allowlist`), its proposal is accepted as `1`, and its `update_policy` call is rejected by the network (`isn't allowed by the access key`).
3. **The founder fires and rehires the agent.** `revoke_agent` deleted the key ([transaction](https://explorer.testnet.near.org/transactions/2pFH9SePN6REQ172fZbzRFcsiB1tvp5rFagV9PigENC5)) and the agent's next call failed with `Access key ... does not exist`. `set_agent_key` added it back ([transaction](https://explorer.testnet.near.org/transactions/3XJqZ1wSxaxEMn5dd1mvfNYTmMT83uefCfvBzM2K6Vhy)) and the agent's next proposal was accepted as `2`.
4. **Earlier sign-up.** `keel-owner.testnet` called `create_vault` with `"kora"`. You see `"kora.keel.testnet"` returned and a `vault_created` event ([transaction](https://explorer.testnet.near.org/transactions/GLV4QR6FwuZeTSPWWHrEvZxdsFky4dGVTNKx5H69W4Fy)).
5. **One founder, several companies.** The same founder added `"lumen"` ([transaction](https://explorer.testnet.near.org/transactions/QX7P8RhhbXG1AbMo87KQNvE2hn6QUEGqRhen6L6bud2)). You see `get_vaults_for_owner` on `keel.testnet` return all three: `kora`, `lumen` and `nova`. Each vault has its own money, policy and agent key.
6. **Same code everywhere.** `get_config` on `keel.testnet` shows `vault_code_hash` `9SgNmzqisrrABrdJ83bJbci9VcZXWdavyosrjJrfsMUk`, the base58 SHA-256 of `contract/target/near/keel_vault.wasm` built from this repository at this commit.

## Mainnet Intents leg

NEAR Intents has no testnet, so cross-chain moves run on mainnet through a second Keel Vault capped at a 5 USDC budget. On testnet, the shortfall scenario in Try it uses a dry quote instead.

1. **List tokens.** Keel calls 1Click's token list. You see USDC on NEAR and on the target chain.
2. **Dry quote.** Keel requests a quote without a deposit address. You see the expected output and fee in the proposal.
3. **Real quote after approval.** Once the owner approves, Keel requests a real quote. You see a deposit address valid for about 10 minutes.
4. **Fund through the vault.** Keel funds that address through the vault at once. You see the vault's transaction hash.
5. **Poll status.** Keel polls `/v0/status` until the swap is final. You see `SUCCESS`, `FAILED` or `REFUNDED` on the ledger page, with the 1Click id.

**Fees:** requests without a partner JWT pay an extra 0.2%. Set `ONECLICK_JWT` in `.env` to remove it.

**Verify it yourself:** open the mainnet vault's transactions in a NEAR explorer and match each one to its ledger row.

## NEAR tools used

- NEAR smart contract (Keel Vault)
- Function-call access keys (scoped agent key)
- NEAR Intents 1Click API (cross-chain moves)
- NEAR AI Cloud (planned, for the Decide step)

## Repo layout and configuration

| Path | What it holds |
| --- | --- |
| `contract/` | Keel Vault smart contract and its tests |
| `factory/` | Keel factory: one vault per company, created when a founder signs up or adds a company |
| `agent/` | The loop: observe, forecast, decide, check, act, reconcile, learn |
| `agent/memory.json` | Human overrides and rule-draft history |
| `config/treasury.json` | Wallets, minimums, payees and upcoming bills |
| `scripts/` | `deploy-factory-testnet.sh`, `new-agent-key.mjs` (Keel's agent keypair), and the planned demo scripts |
| `web/` | The app: wallet sign-in, one vault per company, company switcher and Overview (Vite, React, TypeScript, NEAR Connect) |
| `test-token/` | Keel Test USDC, a NEP-141 token with 6 decimals for testnet only |

| `.env` variable | Purpose |
| --- | --- |
| `NEAR_NETWORK` | `testnet` or `mainnet` |
| `FACTORY_ACCOUNT_ID` | Keel factory, `keel.testnet` on testnet |
| `AGENT_KEY_FILE` | Path to Keel's agent key file from `scripts/new-agent-key.mjs`, outside the repository |
| `USDC_CONTRACT_ID` | USDC token contract on the chosen network |
| `ONECLICK_JWT` | Optional partner token; removes the 0.2% fee |

The owner's private key is never put in `.env`. Owner actions sign through the NEAR CLI or a wallet.

## Limits and known issues

- **Mainnet budget:** the Intents leg moves at most 5 USDC. Dashboard figures such as 48,215.40 USDC are sample data.
- **Forecast inputs:** bills and invoices come from `config/treasury.json`, not from an accounting system.
- **Learning is rule-based:** Keel drafts a cap change after 3 approvals in a row for one payee, and flags any bill more than 25% above that payee's last 3. It never changes a limit itself.
- **Counterparty check:** on-chain signals and the vault blocklist only; no external risk scoring.
- **Single owner:** one full-access key approves everything; multisig approval is not built.

## Libraries and AI-generated code

- [near-sdk 5.30](https://crates.io/crates/near-sdk) and [near-contract-standards 5.30](https://crates.io/crates/near-contract-standards) for the contracts
- [cargo-near 0.22](https://crates.io/crates/cargo-near) to build them, [near-cli-rs 0.30](https://www.npmjs.com/package/near-cli-rs) to deploy and call them
- [NEAR Connect 0.11](https://www.npmjs.com/package/@hot-labs/near-connect) for wallet sign-in, with [React 19](https://react.dev), [Vite 8](https://vite.dev) and TypeScript 5.9 for the app

Parts of this project are written with AI coding agents (Claude Code).

## License

MIT, see [LICENSE](LICENSE).
