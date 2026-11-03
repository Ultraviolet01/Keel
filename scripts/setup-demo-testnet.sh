#!/usr/bin/env bash
# Prepares one vault for `npm run demo` on testnet.
#
#   OWNER=keel-owner.testnet VAULT=beacon.keel.testnet scripts/setup-demo-testnet.sh
#
# 1. Creates the demo payees from the faucet (free testnet accounts).
# 2. Signs update_policy as the owner: 5 USDC per payment, 25 per day by
#    default (PER_PAYMENT and DAILY, in whole USDC), Northwind and Payroll
#    allowed, the scam account blocked.
# 3. Funds the vault. Vaults created now hold Circle's USDC on NEAR testnet:
#    the script prints the vault address to fund at https://faucet.circle.com
#    ("Near Testnet"). Older vaults hold Keel Test USDC, which the script mints
#    (OWNER must own that token).
#
# Signs testnet transactions with OWNER's key from ~/.near-credentials.

set -euo pipefail

: "${OWNER:?Set OWNER, the vault owner, for example OWNER=keel-owner.testnet}"
: "${VAULT:?Set VAULT, for example VAULT=beacon.keel.testnet}"
PER_PAYMENT="${PER_PAYMENT:-5}"
DAILY="${DAILY:-25}"
NET=testnet
RPC=https://test.rpc.fastnear.com
TEST_TOKEN=usdc.keel-owner.testnet
CIRCLE_USDC=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
PAYEES=(northwind-keel.testnet atlas-keel.testnet payroll-keel.testnet scam-keel.testnet)

step() { printf '\n==> %s\n' "$1"; }

exists() {
  curl -sS "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
    | grep -q '"result"'
}

# The token the vault was created with, from its own get_policy.
vault_token() {
  curl -sS "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$VAULT\",\"method_name\":\"get_policy\",\"args_base64\":\"e30=\"}}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result;console.log(JSON.parse(Buffer.from(r.result).toString()).token_id)})'
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

TOKEN="$(vault_token)"
if [ "$TOKEN" = "$TEST_TOKEN" ]; then
  step "Minting 1,000 Keel Test USDC to $VAULT"
  near contract call-function as-transaction "$TOKEN" mint \
    json-args "{\"account_id\":\"$VAULT\",\"amount\":\"1000000000\"}" \
    prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
    sign-as "$OWNER" network-config "$NET" sign-with-legacy-keychain send
elif [ "$TOKEN" = "$CIRCLE_USDC" ]; then
  step "Fund $VAULT with Circle's testnet USDC"
  echo "Open https://faucet.circle.com, pick \"Near Testnet\", and send USDC to:"
  echo "  $VAULT"
  echo "About 25 USDC covers the demo bills (20 from one faucet request is enough to run it)."
else
  step "Fund $VAULT with $TOKEN yourself"
fi

step "Ready"
echo "Run: cd agent && DEMO_VAULT=$VAULT npm run demo"
