# Keel Vault contract

Rust smart contract (near-sdk 5.30) that holds the company's USDC and enforces the limits Keel's agent must stay inside.

## Run the tests

1. Run `cargo test` in this folder. You see 114 tests pass.
2. Each rule in the root README has a test, for example `refuses_payment_over_cap`, `refuses_blocklisted_payee`, `agent_cannot_change_policy`, `pause_blocks_everything_until_resume`, `agent_cannot_pay_the_same_bill_twice`, `at_most_50_proposals_wait_at_once` and `signing_hash_matches_an_independent_encoder`.

## Build the wasm

1. Install cargo-near: `cargo install cargo-near --locked` (on Linux it needs `libudev-dev`).
2. Run `cargo near build non-reproducible-wasm`. You see `target/near/keel_vault.wasm`.

## Methods

Amounts are in the token's smallest unit. USDC has 6 decimals, so 100 USDC is `"100000000"`.

| Method | Caller | Arguments |
| --- | --- | --- |
| `new` | Deployer, once | `owner_id`, `agent_key`, `token_id`. Starts with no policy: caps 0, empty lists. Sets the EVM routes for the network: Base, Ethereum, Arbitrum and Optimism Sepolia on testnet; Base, Ethereum, Arbitrum and Optimism on mainnet |
| `execute_payment` | Agent | `receiver_id`, `amount`, `memo?`, `bill_ref?` |
| `propose_payment` | Agent | `receiver_id`, `amount`, `memo?`, `reason`, `valid_until_ms?`, `evm?`, `bill_ref?`. At most 50 wait at once |
| `approve` | Owner, 1 yoctoNEAR | `proposal_id`. Refused after `valid_until_ms`; for an `evm` proposal it asks the MPC contract to sign (attach 300 Tgas) |
| `reject` | Owner, 1 yoctoNEAR | `proposal_id` |
| `update_policy` | Owner, 1 yoctoNEAR | `update: { per_payment_cap?, daily_cap?, min_balance?, allow?, disallow?, block?, unblock? }`, `reason`. `min_balance` is the cash buffer: with it set, `execute_payment` reads the vault's balance first and pays only if the buffer holds after this and every other agent payment in flight |
| `add_bill` / `cancel_bill` | Owner, 1 yoctoNEAR | `bill: { id, payee, amount, due, monthly?, yearly?, category?, critical?, chain?, label, memo? }` / `id`. At most 50 |
| `add_payee` / `remove_payee` | Owner, 1 yoctoNEAR | `payee: { account_id, name, kind, keep_at?, max_move?, lending? }` / `account_id`. Adding also allowlists; `kind` is vendor, employee, card, offramp, own, yield or other; `keep_at` only for card or own; `max_move` required for yield; `lending` only for yield |
| `recall_from_yield` | Agent, or owner with 1 yoctoNEAR | `market`, `max_amount?` (in the market's units; omit for all). Withdraws from an approved lending market back into the vault; works while paused |
| `pause` / `resume` | Owner, 1 yoctoNEAR | none |
| `revoke_agent` | Owner, 1 yoctoNEAR | none. Deletes the agent key from the vault account |
| `set_agent_key` | Owner, 1 yoctoNEAR | `agent_key`. Replaces the agent key (or adds one after a revoke) |
| `withdraw` | Owner, 1 yoctoNEAR | `receiver_id`, `amount`, `memo?`. Works while paused |
| `set_evm_route` | Owner, 1 yoctoNEAR | `chain_id`, `route: { chain_id, token, decimals, max_fee_per_gas, max_gas }`, or `route: null` to turn that chain off |
| `withdraw_evm` | Owner, 1 yoctoNEAR | `evm`, `amount`, `memo?`. Signs a USDC transfer out of the vault's Base address |
| `release_bill` | Owner, 1 yoctoNEAR | `bill_ref`. Lets a bill be paid again after the owner confirms it never arrived |
| `check_payment` | Anyone (view) | `receiver_id`, `amount` → `{ band, reason }` |
| `get_policy` | Anyone (view) | none |
| `get_proposal` / `get_proposals` | Anyone (view) | `proposal_id` / `from_index?`, `limit?` |
| `bill_paid_at` | Anyone (view) | `bill_ref` → time in ms, or `null` |
| `pending_count` | Anyone (view) | none |
| `get_bills` / `get_payees` | Anyone (view) | none |
| `get_evm_route` | Anyone (view) | none → `routes`, MPC contract, path and predecessor for deriving the vault's EVM address |

`evm` is `{ chain_id, token, to, nonce, max_fee_per_gas, max_priority_fee_per_gas, gas_limit }`. For an `evm` proposal, `receiver_id` is the payee's lowercase 0x address, so the blocklist applies to it.

## Design notes

- **The agent key lives on the vault account.** Whoever deploys the vault (the factory) adds the agent's public key as a function-call key on the vault account, limited to `execute_payment`, `propose_payment` and `recall_from_yield`. The agent signs as the vault, and `assert_agent` checks both that the call came from the vault account and that the agent key signed it. The owner manages the key through `revoke_agent` and `set_agent_key`, which delete and add keys on the vault's own account.
- **Owner methods need 1 yoctoNEAR attached.** Function-call keys cannot attach a deposit, so only a full-access key can approve, change the policy or pause.
- **Refusals are failed transactions.** When the vault refuses, the call panics with `Keel Vault refused: <reason>`. The failed receipt is the on-chain proof of the refusal.
- **Every payment registers the payee first.** The vault calls `storage_deposit` with `registration_only: true` and 0.00125 NEAR, which the token refunds if the payee is already registered. Then it calls `ft_transfer` with 1 yoctoNEAR.
- **A failed transfer does not use up the daily cap.** The callback gives the amount back to today's total and marks failed proposals as `failed`.
- **Approved proposals do not count against the daily cap.** The cap limits what the agent spends alone.
- **Each bill is paid once.** `bill_ref` is recorded when a payment starts; a second payment or proposal for it is refused. A failed transfer or a failed MPC signature frees it again.
- **Flood limits.** At most 50 proposals wait, a newer proposal for the same bill deletes the waiting one, and the agent's calls are refused once the vault's spare NEAR would drop below 0.2, so the owner can always act.
- **EVM transfers.** The vault builds the EIP-1559 USDC `transfer`, hashes it with keccak256, asks `v1.signer-prod.testnet` (`v1.signer` on mainnet) to sign it under path `evm`, and stores the signed bytes and hash in `evm_signed`. It checks chain, token, payee, gas and fee caps first, and converts the amount from the vault's 6 decimals to the token's (6 for USDC; up to 30 for other tokens the owner adds), fixing it in `evm_amount` when the proposal is made.
- **Events** are logged as `EVENT_JSON:{"standard":"keel",...}` for `payment_started`, `payment_executed`, `payment_failed`, `proposal_created`, `proposal_approved`, `proposal_rejected`, `proposal_superseded`, `policy_updated`, `paused`, `resumed`, `withdrawal_started`, `agent_revoked`, `agent_key_set`, `evm_route_set`, `evm_signed`, `evm_sign_failed` and `bill_released`.
