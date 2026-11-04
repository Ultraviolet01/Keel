#!/usr/bin/env bash
# Prepares one vault for `npm run demo` on testnet.
#
#   OWNER=keel-owner.testnet VAULT=compass.keel.testnet scripts/setup-demo-testnet.sh
#
# 1. Creates the demo payees from the faucet (free testnet accounts).
# 2. Signs update_policy as the owner: 5 USDC per payment, 25 per day by
#    default (PER_PAYMENT and DAILY, in whole USDC), Northwind and Payroll
#    allowed, the scam account blocked.
# 3. Prints the vault address to fund with Circle's testnet USDC at
#    https://faucet.circle.com ("Near Testnet").
#
# Signs testnet transactions with OWNER's key from ~/.near-credentials.

set -euo pipefail

: "${OWNER:?Set OWNER, the vault owner, for example OWNER=keel-owner.testnet}"
: "${VAULT:?Set VAULT, for example VAULT=compass.keel.testnet}"
PER_PAYMENT="${PER_PAYMENT:-5}"
DAILY="${DAILY:-25}"
NET=testnet
RPC=https://test.rpc.fastnear.com
PAYEES=(northwind-keel.testnet atlas-keel.testnet payroll-keel.testnet scam-keel.testnet)

step() { printf '\n==> %s\n' "$1"; }

exists() {
  curl -sS "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
    | grep -q '"result"'
}

units() { node -e "console.log(String(BigInt(Math.round(Number(process.argv[1]) * 1e6))))" "$1"; }

step "Creating demo payees"
for p in "${PAYEES[@]}"; do
  if exists "$p"; then
    echo "$p already exists"
  else
    near account create-account sponsor-by-faucet-service "$p" autogenerate-new-keypair \
      save-to-legacy-keychain network-config "$NET" create
  fi
done

step "Setting the demo policy on $VAULT: $PER_PAYMENT per payment, $DAILY per day"
near contract call-function as-transaction "$VAULT" update_policy json-args "{
  \"update\": {
    \"per_payment_cap\": \"$(units "$PER_PAYMENT")\",
    \"daily_cap\": \"$(units "$DAILY")\",
    \"allow\": [\"northwind-keel.testnet\", \"payroll-keel.testnet\"],
    \"block\": [\"scam-keel.testnet\"]
  },
  \"reason\": \"Demo policy: $PER_PAYMENT per payment, $DAILY per day\"
}" prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as "$OWNER" network-config "$NET" sign-with-legacy-keychain send

step "Fund $VAULT with Circle's testnet USDC"
echo "Open https://faucet.circle.com, pick \"Near Testnet\", and send USDC to:"
echo "  $VAULT"

step "Ready"
echo "Run: cd agent && DEMO_VAULT=$VAULT npm run demo"
