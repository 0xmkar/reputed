# Sourced by the other scripts. Never add `set -x` here: the key variables would be printed.
set -euo pipefail

CONTRACTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$CONTRACTS_DIR/../.env}"

die() {
  echo "error: $*" >&2
  exit 1
}

[ -f "$ENV_FILE" ] || die "no env file at $ENV_FILE"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

RPC_URL="${RPC_URL:-https://testnet.hashio.io/api}"
IDENTITY_REGISTRY="${IDENTITY_REGISTRY:-0x8004A818BFB912233c491871b3d84c89A494BD9e}"
[ -n "${OPERATOR_KEY:-}" ] || die "OPERATOR_KEY is not set in $ENV_FILE"

# Never print the value. A raw Ed25519 key has the same shape as an ECDSA one and cannot be told apart
# here: cast takes it and derives an address that holds nothing, so sends fail for lack of funds.
for key_name in OPERATOR_KEY VERIFIER_KEY ISSUER_KEY; do
  [ -z "${!key_name:-}" ] || [[ "${!key_name}" =~ ^(0x)?[0-9a-fA-F]{64}$ ]] ||
    die "$key_name must be a raw 32-byte ECDSA key in hex, not a DER export. See Environment in contracts/README.md"
done

address_of_key() {
  cast wallet address --private-key "$1"
}

# Sends a transaction with the given key and prints the receipt JSON, whatever its status.
submit() {
  local key="$1"
  shift
  cast send --json --rpc-url "$RPC_URL" --private-key "$key" "$@"
}

succeeded() {
  case "$(jq -r .status <<<"$1")" in
    0x1 | 1) return 0 ;;
    *) return 1 ;;
  esac
}

# Like submit, but fails unless the receipt says the transaction succeeded.
send_as() {
  local receipt
  receipt="$(submit "$@")"
  succeeded "$receipt" || die "transaction failed: $(jq -r .transactionHash <<<"$receipt")"
  echo "$receipt"
}

send() {
  send_as "$OPERATOR_KEY" "$@"
}
