#!/usr/bin/env bash
# Tops up every test account in .env from the operator. Safe to re-run.
# An address with no Hedera account yet becomes a hollow account with unlimited auto-association.
source "$(dirname "$0")/common.sh"

FUND_HBAR="${FUND_HBAR:-10}"
# Lazy creation is the expensive case: the relay estimates about 664,000 gas.
FUND_GAS="${FUND_GAS:-800000}"
ACCOUNTS=(CREATOR_A CREATOR_B CREATOR_C AGENT_A1 AGENT_A2 AGENT_B1 AGENT_C1 WALLET_U)

target="$(cast to-wei "$FUND_HBAR")"
for name in "${ACCOUNTS[@]}"; do
  var="${name}_ADDRESS"
  address="${!var:-}"
  [ -n "$address" ] || die "$var is not set in $ENV_FILE. See Environment in contracts/README.md"

  balance="$(cast balance --rpc-url "$RPC_URL" "$address")"
  if [ "$(python3 -c "print(int($balance >= $target))")" = 1 ]; then
    echo "$name $address already has at least $FUND_HBAR HBAR"
    continue
  fi
  send --gas-limit "$FUND_GAS" --value "${FUND_HBAR}ether" "$address" >/dev/null
  echo "$name $address funded with $FUND_HBAR HBAR"
done
