#!/usr/bin/env bash
# Prepares one vault for `npm run demo` on testnet.
#
#   OWNER=keel-owner.testnet VAULT=anchor.keel.testnet scripts/setup-demo-testnet.sh
#
# 1. Creates the demo payees from the faucet (free testnet accounts).
# 2. Signs update_policy as the owner: 100 per payment, 500 per day,
#    Northwind and Payroll allowed, the scam account blocked.
# 3. Mints 1,000 test USDC to the vault (OWNER must own the test token).
#
# Signs testnet transactions with OWNER's key from ~/.near-credentials.

set -euo pipefail

: "${OWNER:?Set OWNER, the vault owner, for example OWNER=keel-owner.testnet}"
: "${VAULT:?Set VAULT, for example VAULT=anchor.keel.testnet}"
TOKEN="${TOKEN:-usdc.keel-owner.testnet}"
NET=testnet
PAYEES=(northwind-keel.testnet atlas-keel.testnet payroll-keel.testnet scam-keel.testnet)

step() { printf '\n==> %s\n' "$1"; }

exists() {
  curl -sS https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
    | grep -q '"result"'
}

step "Creating demo payees"
for p in "${PAYEES[@]}"; do
  if exists "$p"; then
    echo "$p already exists"
  else
    near account create-account sponsor-by-faucet-service "$p" autogenerate-new-keypair \
      save-to-legacy-keychain network-config "$NET" create
  fi
done

step "Setting the demo policy on $VAULT"
near contract call-function as-transaction "$VAULT" update_policy json-args '{
  "update": {
    "per_payment_cap": "100000000",
    "daily_cap": "500000000",
    "allow": ["northwind-keel.testnet", "payroll-keel.testnet"],
    "block": ["scam-keel.testnet"]
  },
  "reason": "Demo policy: 100 per payment, 500 per day"
}' prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as "$OWNER" network-config "$NET" sign-with-legacy-keychain send

step "Minting 1,000 test USDC to $VAULT"
near contract call-function as-transaction "$TOKEN" mint \
  json-args "{\"account_id\":\"$VAULT\",\"amount\":\"1000000000\"}" \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
  sign-as "$OWNER" network-config "$NET" sign-with-legacy-keychain send

step "Ready"
echo "Run: cd agent && DEMO_VAULT=$VAULT npm run demo"
