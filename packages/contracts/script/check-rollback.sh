#!/usr/bin/env bash
# T1.9b, on testnet: does a failed revoke really leave the holder frozen? revokeCredential unfreezes
# before it wipes, so a rollback that did not happen would leave a credential transferable. The
# preflight cannot answer this, because the simulator keeps the effects of nested reverts.
#
# Needs a funded operator, plus CREATOR_REGISTRY and CREDENTIAL_TOKEN_ID. Costs about 5 HBAR.
# ROLLBACK_HOLDER picks the wallet, and defaults to AGENT_C1_ADDRESS. Exits non-zero on any failure.
source "$(dirname "$0")/common.sh"

MIRROR_NODE="${MIRROR_NODE:-https://testnet.mirrornode.hedera.com}"
ISSUE_GAS="${ISSUE_GAS:-1500000}"
REVOKE_GAS="${REVOKE_GAS:-300000}"
PROBE_GAS="${PROBE_GAS:-500000}"
PROBE_DEPLOY_GAS="${PROBE_DEPLOY_GAS:-1000000}"
WIPE_SELECTOR=f7f38e26

registry="${CREATOR_REGISTRY:-}"
token="${CREDENTIAL_TOKEN_ID:-}"
holder="${ROLLBACK_HOLDER:-${AGENT_C1_ADDRESS:-}}"
signer="${ISSUER_KEY:-$OPERATOR_KEY}"
[ -n "$registry" ] || die "CREATOR_REGISTRY is not set in $ENV_FILE"
[ -n "$token" ] || die "CREDENTIAL_TOKEN_ID is not set in $ENV_FILE"
[ -n "$holder" ] || die "set ROLLBACK_HOLDER or AGENT_C1_ADDRESS in $ENV_FILE"

# Mirror Node writes a record file in one step, so once the result shows, the token state is current.
wait_for_mirror() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    curl -fsS "$MIRROR_NODE/api/v1/contracts/results/$1" 2>/dev/null && return 0
    sleep 3
  done
  die "the Mirror Node has no result for $1"
}

read_state() {
  local relationship supply
  relationship="$(curl -fsS "$MIRROR_NODE/api/v1/accounts/$holder/tokens?token.id=$token" |
    jq -r '.tokens[0] | "\(.freeze_status) balance=\(.balance)"')"
  supply="$(curl -fsS "$MIRROR_NODE/api/v1/tokens/$token" | jq -r .total_supply)"
  echo "$relationship supply=$supply"
}

fail() {
  echo "FAIL $1" >&2
  echo "Holder $holder still has serial $serial from this run." >&2
  echo "If it reads UNFROZEN, atomicity does not hold: do not rely on revokeCredential or issueCredential" >&2
  echo "until this is understood. Revoking serial $serial refreezes the holder." >&2
  exit 1
}

expect_unchanged() {
  local now
  now="$(read_state)"
  [ "$now" = "$baseline" ] || fail "$1: expected '$baseline', the Mirror Node shows '$now'"
  echo "PASS $1: $now"
}

# Without this, a call that ran out of gas before the unfreeze would pass for the wrong reason.
expect_wipe_failure() {
  [[ "$2" == *"$hts_failed$WIPE_SELECTOR"* ]] || fail "$1 did not fail at the wipe: ${2:-no revert data}"
}

probe=""
role="$(cast keccak ISSUER_ROLE)"
remove_probe_role() {
  [ -n "$probe" ] || return 0
  send --gas-limit 200000 "$registry" 'revokeRole(bytes32,address)' "$role" "$probe" >/dev/null ||
    echo "warning: $probe still holds ISSUER_ROLE, revoke it by hand" >&2
}
trap remove_probe_role EXIT

cd "$CONTRACTS_DIR"
forge build >/dev/null
hts_failed="$(cast sig 'HtsCallFailed(bytes4,int64)' | cut -c3-)"

echo "Setting up: issuing a credential to $holder"
metadata="0x$(printf 'reputed:t1.9b' | od -An -tx1 | tr -d ' \n')"
receipt="$(send_as "$signer" --gas-limit "$ISSUE_GAS" "$registry" 'issueCredential(address,bytes)' "$holder" "$metadata")"
issued_topic="$(cast keccak 'CredentialIssued(address,int64)')"
serial="$(cast to-dec "$(jq -r --arg topic "$issued_topic" '.logs[] | select(.topics[0] == $topic) | .data' <<<"$receipt")")"
wait_for_mirror "$(jq -r .transactionHash <<<"$receipt")" >/dev/null
baseline="$(read_state)"
[[ "$baseline" == FROZEN\ * ]] || fail "holder is not frozen after issuing: $baseline"
echo "Holder has serial $serial: $baseline"

wrong_serial=$((serial + 1000000))

echo "T1.9b top level: revokeCredential($holder, $wrong_serial) as a transaction"
receipt="$(submit "$signer" --gas-limit "$REVOKE_GAS" "$registry" 'revokeCredential(address,int64)' "$holder" "$wrong_serial")"
hash="$(jq -r .transactionHash <<<"$receipt")"
! succeeded "$receipt" || fail "the revoke of a wrong serial succeeded: $hash"
expect_wipe_failure "top-level revoke" "$(wait_for_mirror "$hash" | jq -r .error_message)"
expect_unchanged "top-level revert leaves the holder as it was ($hash)"

echo "T1.9b nested: the same revoke through a contract that catches the revert"
receipt="$(send --gas-limit "$PROBE_DEPLOY_GAS" --create "$(forge inspect RollbackProbe bytecode)")"
deployed="$(jq -r .contractAddress <<<"$receipt")"
[ "$deployed" != null ] || die "no contract address in the probe's deploy receipt"
send --gas-limit 200000 "$registry" 'grantRole(bytes32,address)' "$role" "$deployed" >/dev/null
probe="$deployed"
receipt="$(send --gas-limit "$PROBE_GAS" "$probe" 'revokeAndCatch(address,address,int64)' "$registry" "$holder" "$wrong_serial")"
hash="$(jq -r .transactionHash <<<"$receipt")"
expect_wipe_failure "nested revoke" "$(jq -r '[.logs[].data] | join("")' <<<"$receipt")"
wait_for_mirror "$hash" >/dev/null
expect_unchanged "caught revert leaves the holder as it was ($hash)"

echo "Cleaning up: revoking serial $serial"
receipt="$(send_as "$signer" --gas-limit "$REVOKE_GAS" "$registry" 'revokeCredential(address,int64)' "$holder" "$serial")"
wait_for_mirror "$(jq -r .transactionHash <<<"$receipt")" >/dev/null
echo "Final state: $(read_state)"
echo "T1.9b passed. Record the two transaction hashes above in the README's Evidence table."
