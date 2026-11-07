export const HEDERA_TESTNET = {
  id: 296,
  name: 'Hedera Testnet',
  // 18 is what the JSON-RPC relay reports (weibar). The Mirror Node and the Hedera SDK use tinybar, 8 decimals.
  nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  rpcUrl: 'https://testnet.hashio.io/api',
  mirrorNode: 'https://testnet.mirrornode.hedera.com',
  hashscan: 'https://hashscan.io/testnet',
} as const;

/** The ERC-8004 registries on Hedera testnet. CreatorRegistry's address comes from /api/config instead. */
export const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const;
export const REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713' as const;

export const hashscan = {
  tx: (id: string) => `${HEDERA_TESTNET.hashscan}/transaction/${id}`,
  address: (addr: string) => `${HEDERA_TESTNET.hashscan}/account/${addr}`,
  contract: (addr: string) => `${HEDERA_TESTNET.hashscan}/contract/${addr}`,
  token: (id: string) => `${HEDERA_TESTNET.hashscan}/token/${id}`,
  nft: (id: string, serial: number) => `${HEDERA_TESTNET.hashscan}/token/${id}/${serial}`,
  topic: (id: string) => `${HEDERA_TESTNET.hashscan}/topic/${id}`,
};
