#!/usr/bin/env bash
# Replays every CreatorRegistered event of the previous CreatorRegistry into the current one, so verified
# humans keep their creator record without redoing World ID (the action allows one proof per person).
# Needs CREATOR_REGISTRY (new) and CREATOR_REGISTRY_V1 (old) in .env, and VERIFIER_KEY or OPERATOR_KEY
# holding the new registry's verifier role. Safe to re-run: wallets that are already creators are skipped.
source "$(dirname "$0")/common.sh"

[ -n "${CREATOR_REGISTRY:-}" ] || die "CREATOR_REGISTRY is not set in $ENV_FILE"
[ -n "${CREATOR_REGISTRY_V1:-}" ] || die "CREATOR_REGISTRY_V1 is not set in $ENV_FILE"
verifier_key="${VERIFIER_KEY:-$OPERATOR_KEY}"

topic="$(cast keccak 'CreatorRegistered(bytes32,address)')"
# The Mirror Node only filters topics inside a timestamp range, so read every log and filter here.
events=""
path="/api/v1/contracts/$CREATOR_REGISTRY_V1/results/logs?order=asc&limit=100"
while [ -n "$path" ] && [ "$path" != null ]; do
  page="$(curl -fsS "$MIRROR_NODE$path")" || die "could not read the old registry's logs from the Mirror Node"
  events+="$(jq -r --arg topic "$topic" '.logs[] | select(.topics[0] == $topic) | "\(.topics[1]) \(.topics[2])"' <<<"$page")"$'\n'
  path="$(jq -r '.links.next // empty' <<<"$page")"
done

count=0
while read -r nullifier padded; do
  [ -n "$nullifier" ] || continue
  wallet="0x${padded: -40}"
  if [ "$(cast call --rpc-url "$RPC_URL" "$CREATOR_REGISTRY" 'isCreator(address)(bool)' "$wallet")" = true ]; then
    echo "skip $wallet (already a creator)"
    continue
  fi
  result="$(submit "$verifier_key" --gas-limit 200000 "$CREATOR_REGISTRY" 'registerCreator(bytes32,address)' "$nullifier" "$wallet")"
  if succeeded "$result"; then
    echo "migrated $wallet"
    count=$((count + 1))
  else
    echo "FAILED $wallet: $(jq -r .errorMessage <<<"$result")" >&2
  fi
done <<<"$events"
echo "done: $count migrated"
