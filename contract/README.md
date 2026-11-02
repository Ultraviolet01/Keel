# Keel Vault contract

Rust smart contract (near-sdk 5.30) that holds the company's USDC and enforces the limits Keel's agent must stay inside.

## Run the tests

1. Run `cargo test` in this folder. You see 32 tests pass.
2. Each rule in the root README has a test, for example `refuses_payment_over_cap`, `refuses_blocklisted_payee`, `agent_cannot_change_policy` and `pause_blocks_everything_until_resume`.

## Build the wasm

1. Install cargo-near: `cargo install cargo-near --locked` (on Linux it needs `libudev-dev`).
2. Run `cargo near build non-reproducible-wasm`. You see `target/near/keel_vault.wasm`.

## Methods

Amounts are in the token's smallest unit. USDC has 6 decimals, so 100 USDC is `"100000000"`.

| Method | Caller | Arguments |
| --- | --- | --- |
| `new` | Deployer, once | `owner_id`, `agent_key`, `token_id`. Starts with no policy: caps 0, empty lists |
| `execute_payment` | Agent | `receiver_id`, `amount`, `memo?` |
| `propose_payment` | Agent | `receiver_id`, `amount`, `memo?`, `reason` |
| `approve` | Owner, 1 yoctoNEAR | `proposal_id` |
| `reject` | Owner, 1 yoctoNEAR | `proposal_id` |
| `update_policy` | Owner, 1 yoctoNEAR | `update: { per_payment_cap?, daily_cap?, allow?, disallow?, block?, unblock? }`, `reason` |
| `pause` / `resume` | Owner, 1 yoctoNEAR | none |
| `revoke_agent` | Owner, 1 yoctoNEAR | none. Deletes the agent key from the vault account |
| `set_agent_key` | Owner, 1 yoctoNEAR | `agent_key`. Replaces the agent key (or adds one after a revoke) |
| `withdraw` | Owner, 1 yoctoNEAR | `receiver_id`, `amount`, `memo?`. Works while paused |
| `check_payment` | Anyone (view) | `receiver_id`, `amount` → `{ band, reason }` |
| `get_policy` | Anyone (view) | none |
| `get_proposal` / `get_proposals` | Anyone (view) | `proposal_id` / `from_index?`, `limit?` |

## Design notes

- **The agent key lives on the vault account.** Whoever deploys the vault (the factory) adds the agent's public key as a function-call key on the vault account, limited to `execute_payment` and `propose_payment`. The agent signs as the vault, and `assert_agent` checks both that the call came from the vault account and that the agent key signed it. The owner manages the key through `revoke_agent` and `set_agent_key`, which delete and add keys on the vault's own account.
- **Owner methods need 1 yoctoNEAR attached.** Function-call keys cannot attach a deposit, so only a full-access key can approve, change the policy or pause.
- **Refusals are failed transactions.** When the vault refuses, the call panics with `Keel Vault refused: <reason>`. The failed receipt is the on-chain proof used in the attack demo.
- **Every payment registers the payee first.** The vault calls `storage_deposit` with `registration_only: true` and 0.00125 NEAR, which the token refunds if the payee is already registered. Then it calls `ft_transfer` with 1 yoctoNEAR.
- **A failed transfer does not use up the daily cap.** The callback gives the amount back to today's total and marks failed proposals as `failed`.
- **Approved proposals do not count against the daily cap.** The cap limits what the agent spends alone.
- **Events** are logged as `EVENT_JSON:{"standard":"keel",...}` for `payment_started`, `payment_executed`, `payment_failed`, `proposal_created`, `proposal_approved`, `proposal_rejected`, `policy_updated`, `paused`, `resumed`, `withdrawal_started`, `agent_revoked` and `agent_key_set`. The ledger page reads these.
