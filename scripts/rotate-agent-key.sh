#!/usr/bin/env bash
# Switches Keel's agent to a new key on every vault one owner holds.
#
#   NEW_KEY=ed25519:... OWNER=keel-owner.testnet scripts/rotate-agent-key.sh
#
# NEW_KEY is the public key printed by `node scripts/new-agent-key.mjs`.
# For each vault OWNER owns on keel.testnet, signs set_agent_key as OWNER
# (1 yoctoNEAR attached): the vault deletes the old agent key and adds the new
# one, limited to execute_payment and propose_payment.
# With ADMIN=keel.testnet set, also signs the factory's set_agent_key so new
# vaults get the new key (needs keel.testnet's key on this machine).
#
# Signs testnet transactions with keys from ~/.near-credentials.

set -euo pipefail

: "${NEW_KEY:?Set NEW_KEY, the public key from node scripts/new-agent-key.mjs}"
: "${OWNER:?Set OWNER, the account that owns the vaults, for example keel-owner.testnet}"
FACTORY="${FACTORY:-keel.testnet}"
NET=testnet
RPC=https://test.rpc.fastnear.com

vaults() {
  local args
  args=$(printf '{"owner_id":"%s"}' "$OWNER" | base64 | tr -d '\n')
  curl -sS "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$FACTORY\",\"method_name\":\"get_vaults_for_owner\",\"args_base64\":\"$args\"}}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result;for(const v of JSON.parse(Buffer.from(r.result).toString()))console.log(v)})'
}

for v in $(vaults); do
  printf '\n==> %s: set_agent_key %s\n' "$v" "$NEW_KEY"
  near contract call-function as-transaction "$v" set_agent_key json-args "{\"agent_key\":\"$NEW_KEY\"}" \
    prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' \
    sign-as "$OWNER" network-config "$NET" sign-with-legacy-keychain send || echo "   $v failed; the others continue"
done

if [ -n "${ADMIN:-}" ]; then
  printf '\n==> %s: new vaults get %s\n' "$FACTORY" "$NEW_KEY"
  near contract call-function as-transaction "$FACTORY" set_agent_key json-args "{\"agent_key\":\"$NEW_KEY\"}" \
    prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
    sign-as "$ADMIN" network-config "$NET" sign-with-legacy-keychain send
fi

printf '\nDone. Put the private key from the key file in the GitHub secret KEEL_AGENT_PRIVATE_KEY.\n'
