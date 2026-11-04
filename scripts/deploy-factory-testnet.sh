#!/usr/bin/env bash
# Deploys the Keel factory, which creates one vault per founder at sign-up.
#
#   FACTORY=keel.testnet TOKEN=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af scripts/deploy-factory-testnet.sh
#
# FACTORY must already exist with its full-access key in ~/.near-credentials
# (for example `near account create-account sponsor-by-faucet-service ...`).
# Uses Keel's agent key from AGENT_KEY_FILE (default
# ~/.near-credentials/keel-agent-key.json; create it with
# `node scripts/new-agent-key.mjs`). Deploys the factory with that public key
# and uploads the vault code. Needs about 5 testnet NEAR on FACTORY.

set -euo pipefail

: "${FACTORY:?Set FACTORY, for example FACTORY=keel.testnet}"
: "${TOKEN:?Set TOKEN to the USDC contract, for example TOKEN=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af}"
NET=testnet
AGENT_KEY_FILE="${AGENT_KEY_FILE:-$HOME/.near-credentials/keel-agent-key.json}"
[ -f "$AGENT_KEY_FILE" ] || { echo "No agent key at $AGENT_KEY_FILE. Run: node scripts/new-agent-key.mjs"; exit 1; }
AGENT_KEY="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).public_key)" "$AGENT_KEY_FILE")"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

step() { printf '\n==> %s\n' "$1"; }

step "Building contracts"
(cd "$ROOT/contract" && cargo near build non-reproducible-wasm >/dev/null)
(cd "$ROOT/factory" && cargo near build non-reproducible-wasm >/dev/null)

step "Deploying the factory to $FACTORY"
near contract deploy "$FACTORY" use-file "$ROOT/factory/target/near/keel_factory.wasm" \
  with-init-call new json-args "{\"admin_id\":\"$FACTORY\",\"agent_key\":\"$AGENT_KEY\",\"token_id\":\"$TOKEN\"}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config "$NET" sign-with-legacy-keychain send

step "Uploading the vault code"
near contract call-function as-transaction "$FACTORY" set_vault_code \
  file-args "$ROOT/contract/target/near/keel_vault.wasm" \
  prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' \
  sign-as "$FACTORY" network-config "$NET" sign-with-legacy-keychain send

step "Factory config"
near contract call-function as-read-only "$FACTORY" get_config json-args '{}' network-config "$NET" now
echo "Compare vault_code_hash with: sha256sum contract/target/near/keel_vault.wasm (shown in base58 by the contract)"
