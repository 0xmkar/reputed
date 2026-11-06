#!/usr/bin/env bash
# Regression test for the scripts' setup errors. Needs cast, but no network: every case stops before
# the first RPC call. Run from anywhere: `bash contracts/test/env-checks.sh`.
set -uo pipefail

contracts="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
valid_key="$(printf 'ab%.0s' {1..32})"
failures=0

check() {
  local label="$1" env_lines="$2" want="$3" forbidden="${4:-}" output status
  printf '%s\n' "$env_lines" >"$tmp/env"
  output="$(ENV_FILE="$tmp/env" bash "$contracts/script/fund-accounts.sh" 2>&1)"
  status=$?
  if [ "$status" -eq 0 ] || [[ "$output" != *"$want"* ]] || { [ -n "$forbidden" ] && [[ "$output" == *"$forbidden"* ]]; }; then
    echo "FAIL $label: status $status, output: $output"
    failures=$((failures + 1))
  else
    echo "PASS $label"
  fi
}

der_key="3030020100300706052b8104000a04220420$valid_key"
check 'names the missing variable and where it is documented' "OPERATOR_KEY=$valid_key" \
  'CREATOR_A_ADDRESS is not set' ''
check 'points at the README for a missing variable' "OPERATOR_KEY=$valid_key" 'Environment in contracts/README.md'
check 'rejects a DER operator key without printing it' "OPERATOR_KEY=$der_key" \
  'OPERATOR_KEY must be a raw 32-byte ECDSA key' "$der_key"
check 'rejects a malformed issuer key without printing it' "$(printf 'OPERATOR_KEY=%s\nISSUER_KEY=not-a-key' "$valid_key")" \
  'ISSUER_KEY must be a raw 32-byte ECDSA key' 'not-a-key'

for name in $(sed -n 's/^ACCOUNTS=(\(.*\))$/\1/p' "$contracts/script/fund-accounts.sh") WALLET_U_KEY; do
  case "$name" in *_KEY) var="$name" ;; *) var="${name}_ADDRESS" ;; esac
  if grep -q "^$var=" "$contracts/README.md"; then
    echo "PASS README documents $var"
  else
    echo "FAIL README does not document $var"
    failures=$((failures + 1))
  fi
done

[ "$failures" -eq 0 ] && echo "all passed" || { echo "$failures failed"; exit 1; }
