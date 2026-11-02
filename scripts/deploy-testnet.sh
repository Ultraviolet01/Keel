#!/usr/bin/env bash
# Deploys Keel to NEAR testnet under an owner account you control.
#
#   OWNER=your-name.testnet scripts/deploy-testnet.sh
#
# Creates three sub-accounts of OWNER, deploys the contracts and funds the
# vault with test USDC:
#   usdc.OWNER   Keel Test USDC (6 decimals, no value)
#   vault.OWNER  Keel Vault, starting with no policy
#   agent.OWNER  the agent, with a function-call key that can only call the
#                vault's execute_payment and propose_payment
#
# Needs: near CLI (near-cli-rs), cargo-near, and OWNER's full-access key in
# ~/.near-credentials/testnet (for example from `near account import-account`).
# Costs about 7 testnet NEAR. Keys are saved to ~/.near-credentials, never to
# this repository.

set -euo pipefail

: "${OWNER:?Set OWNER to your testnet account, for example OWNER=keel-owner.testnet}"
NET=testnet
VAULT="vault.$OWNER"
AGENT="agent.$OWNER"
USDC="usdc.$OWNER"
VAULT_FUNDING_USDC="${VAULT_FUNDING_USDC:-1000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

step() { printf '\n==> %s\n' "$1"; }

step "Building contracts"
(cd "$ROOT/contract" && cargo near build non-reproducible-wasm >/dev/null)
(cd "$ROOT/test-token" && cargo near build non-reproducible-wasm >/dev/null)

create_sub() {
  near account create-account fund-myself "$1" "$2" \
    autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$OWNER" network-config "$NET" sign-with-legacy-keychain send
}

step "Creating $USDC, $VAULT and $AGENT"
create_sub "$USDC" '2.5 NEAR'
create_sub "$VAULT" '3 NEAR'
create_sub "$AGENT" '1 NEAR'

step "Deploying Keel Test USDC to $USDC"
near contract deploy "$USDC" use-file "$ROOT/test-token/target/near/keel_test_usdc.wasm" \
  with-init-call new json-args "{\"owner_id\":\"$OWNER\",\"total_supply\":\"0\"}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config "$NET" sign-with-legacy-keychain send

step "Deploying Keel Vault to $VAULT (no policy: the owner sets it)"
near contract deploy "$VAULT" use-file "$ROOT/contract/target/near/keel_vault.wasm" \
  with-init-call new json-args "{\"owner_id\":\"$OWNER\",\"agent_id\":\"$AGENT\",\"token_id\":\"$USDC\"}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config "$NET" sign-with-legacy-keychain send

step "Giving $AGENT a function-call key for the vault only"
near account add-key "$AGENT" grant-function-call-access \
  --allowance '1 NEAR' \
  --contract-account-id "$VAULT" \
  --function-names 'execute_payment, propose_payment' \
  autogenerate-new-keypair save-to-legacy-keychain \
  network-config "$NET" sign-with-legacy-keychain send

step "Minting $VAULT_FUNDING_USDC test USDC to the vault"
near contract call-function as-transaction "$USDC" mint \
  json-args "{\"account_id\":\"$VAULT\",\"amount\":\"$((VAULT_FUNDING_USDC * 1000000))\"}" \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  sign-as "$OWNER" network-config "$NET" sign-with-legacy-keychain send

step "Done"
cat <<EOF
Add these to .env:
NEAR_NETWORK=$NET
OWNER_ACCOUNT_ID=$OWNER
AGENT_ACCOUNT_ID=$AGENT
VAULT_ACCOUNT_ID=$VAULT
USDC_CONTRACT_ID=$USDC
EOF
