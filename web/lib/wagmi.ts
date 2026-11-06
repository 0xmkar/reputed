import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { defineChain } from 'viem';
import { HEDERA_TESTNET } from '@reputed/shared';

export const hederaTestnet = defineChain({
  id: HEDERA_TESTNET.id,
  name: HEDERA_TESTNET.name,
  nativeCurrency: HEDERA_TESTNET.nativeCurrency,
  rpcUrls: { default: { http: [HEDERA_TESTNET.rpcUrl] } },
  blockExplorers: { default: { name: 'HashScan', url: HEDERA_TESTNET.hashscan } },
});

export const wagmiConfig = createConfig({
  chains: [hederaTestnet],
  connectors: [injected()],
  transports: { [hederaTestnet.id]: http(HEDERA_TESTNET.rpcUrl) },
  ssr: true,
});
