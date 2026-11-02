# Keel factory

Creates one Keel Vault per founder when they sign up. Live on testnet at `keel.testnet`.

## Run the tests

1. Run `cargo test` in this folder. You see 12 tests pass, including `one_vault_per_founder`, `failed_creation_frees_name_and_refunds` and `only_admin_uploads_vault_code`.

## How sign-up works

1. The founder's wallet calls `create_vault({"name":"kora"})` with at least `min_vault_deposit` attached (about 2.29 NEAR for the current code).
2. The factory creates `kora.keel.testnet`, copies the vault code into it and calls `new` with the founder as owner and Keel's agent as agent. The vault starts with no policy.
3. A callback registers the vault on the token so it can receive USDC, logs `vault_created` and returns the vault id. If creation fails, the name is freed and the full deposit goes back to the founder.
4. The Keel operator runs `scripts/add-agent-key.sh <vault>` to give the agent a function-call key for that vault only.

## Methods

| Method | Caller | Notes |
| --- | --- | --- |
| `new` | Deployer, once | `admin_id`, `agent_id`, `token_id` |
| `set_vault_code` | Admin | Raw wasm as the call input. Sets the code for new vaults and records its SHA-256 |
| `create_vault` | Founder, with deposit | `name`: 2 to 32 lowercase letters, digits, `-` or `_`. One vault per founder |
| `get_vault` | Anyone (view) | `owner_id` → vault id or null |
| `get_vaults` | Anyone (view) | `from_index?`, `limit?` |
| `get_config` | Anyone (view) | Admin, agent, token, `vault_code_hash`, `vault_code_bytes`, `min_vault_deposit` |

## Cost note

Each vault stores its own copy of the code, so the founder's deposit locks about 2 NEAR of storage, which stays in the vault. NEAR global contracts would store the code once for all vaults and make sign-up cheap, but publishing them burns 10 NEAR per 100 KB (about 20 NEAR for this vault), so they make sense on mainnet once there are many founders.
