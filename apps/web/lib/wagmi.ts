import { createConfig, http, type CreateConnectorFn } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';
import { defineChain } from 'viem';
import { HEDERA_TESTNET } from '@reputed/shared';

export const hederaTestnet = defineChain({
  id: HEDERA_TESTNET.id,
  name: HEDERA_TESTNET.name,
  nativeCurrency: HEDERA_TESTNET.nativeCurrency,
  rpcUrls: { default: { http: [HEDERA_TESTNET.rpcUrl] } },
  blockExplorers: { default: { name: 'HashScan', url: HEDERA_TESTNET.hashscan } },
});

/** Public value from cloud.reown.com. Without it the app offers browser-extension wallets only. */
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

const connectors: CreateConnectorFn[] = [injected()];
if (walletConnectProjectId) {
  // HashPack pairs over WalletConnect's EVM namespace, so every signature stays EIP-191/EIP-712
  // and the server checks it the same way as MetaMask's.
  connectors.push(
    walletConnect({
      projectId: walletConnectProjectId,
      metadata: {
        name: 'Reputed',
        description: 'Human-backed reputation for AI agents on Hedera',
        url: typeof window === 'undefined' ? 'http://localhost:3000' : window.location.origin,
        icons: [],
      },
      showQrModal: true,
    }),
  );
}

export const wagmiConfig = createConfig({
  chains: [hederaTestnet],
  connectors,
  // Lists every extension wallet that announces itself (EIP-6963), HashPack's included.
  multiInjectedProviderDiscovery: true,
  transports: { [hederaTestnet.id]: http(HEDERA_TESTNET.rpcUrl) },
  ssr: true,
});
