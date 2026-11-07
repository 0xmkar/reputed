#!/usr/bin/env bash
# Deploys CreatorRegistry with its roles, creates the credential collection, and prints the .env lines.
# If CREATOR_REGISTRY is already set it skips the deploy, so a failed init can be retried.
source "$(dirname "$0")/common.sh"

# The relay counts value in 18 decimals, so `20ether` reaches the contract as 20 HBAR in tinybars.
# Creation cost 17.4 HBAR at the 2026-11-06 rate, and the surplus stays in the contract.
INIT_HBAR="${INIT_HBAR:-20}"
DEPLOY_GAS="${DEPLOY_GAS:-3000000}" # the relay estimates about 2,000,000
INIT_GAS="${INIT_GAS:-1000000}"     # simulated use is about 172,000 plus the fee sent as value

operator="$(address_of_key "$OPERATOR_KEY")"
verifier="$operator"
issuer="$operator"
[ -z "${VERIFIER_KEY:-}" ] || verifier="$(address_of_key "$VERIFIER_KEY")"
[ -z "${ISSUER_KEY:-}" ] || issuer="$(address_of_key "$ISSUER_KEY")"

cd "$CONTRACTS_DIR"
registry="${CREATOR_REGISTRY:-}"
if [ -z "$registry" ]; then
  forge build >/dev/null
  bytecode="$(forge inspect CreatorRegistry bytecode)"
  args="$(cast abi-encode 'constructor(address,address,address,address)' \
    "$IDENTITY_REGISTRY" "$operator" "$verifier" "$issuer")"
  registry="$(send --gas-limit "$DEPLOY_GAS" --create "${bytecode}${args#0x}" | jq -r .contractAddress)"
  [ "$registry" != null ] || die "no contract address in the deploy receipt"
  echo "deployed CreatorRegistry at $registry" >&2
  echo "  admin $operator, verifier $verifier, issuer $issuer" >&2
fi

zero=0x0000000000000000000000000000000000000000
read_token() {
  cast call --rpc-url "$RPC_URL" "$registry" 'credentialToken()(address)'
}

token="$zero"
[ -z "${CREATOR_REGISTRY:-}" ] || token="$(read_token)"

if [ "$token" = "$zero" ]; then
  send --gas-limit "$INIT_GAS" --value "${INIT_HBAR}ether" "$registry" 'initCredentialToken()' >/dev/null
  # The relay reads through the Mirror Node, which lags consensus by a few seconds.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    token="$(read_token)"
    [ "$token" = "$zero" ] || break
    sleep 3
  done
  [ "$token" != "$zero" ] || die "credentialToken() is still zero after init on $registry"
  echo "created credential token at $token" >&2
fi

echo "# Add these to .env"
echo "CREATOR_REGISTRY=$registry"
echo "CREDENTIAL_TOKEN_ID=0.0.$(cast to-dec "$token")"
