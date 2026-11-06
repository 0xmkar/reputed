import { HEDERA_TESTNET } from '@reputed/shared';

export function NetworkPill() {
  return <span className="pill">{HEDERA_TESTNET.name}</span>;
}
