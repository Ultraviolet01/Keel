#!/usr/bin/env bash
# Gives Keel's agent a function-call key for one founder's vault. Run by the
# Keel operator after the factory logs `vault_created`. The key can only call
# that vault's execute_payment and propose_payment.
#
#   AGENT=agent.keel.testnet scripts/add-agent-key.sh kora.keel.testnet

set -euo pipefail

VAULT="${1:?Usage: AGENT=agent.keel.testnet scripts/add-agent-key.sh <vault-account>}"
: "${AGENT:?Set AGENT, for example AGENT=agent.keel.testnet}"
NET="${NEAR_NETWORK:-testnet}"

near account add-key "$AGENT" grant-function-call-access \
  --allowance '0.5 NEAR' \
  --contract-account-id "$VAULT" \
  --function-names 'execute_payment, propose_payment' \
  autogenerate-new-keypair save-to-legacy-keychain \
  network-config "$NET" sign-with-legacy-keychain send
