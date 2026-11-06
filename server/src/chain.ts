import { creatorRegistryAbi, HEDERA_TESTNET } from '@reputed/shared';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export function hederaChain(rpcUrl: string = HEDERA_TESTNET.rpcUrl): Chain {
  return defineChain({
    id: HEDERA_TESTNET.id,
    name: HEDERA_TESTNET.name,
    nativeCurrency: HEDERA_TESTNET.nativeCurrency,
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'HashScan', url: HEDERA_TESTNET.hashscan } },
  });
}

export function createChainClients(rpcUrl: string, verifierKey: Hex) {
  const chain = hederaChain(rpcUrl);
  const transport = http(rpcUrl, { timeout: 20_000, retryCount: 1 });
  return {
    publicClient: createPublicClient({ chain, transport, pollingInterval: 1_000 }),
    walletClient: createWalletClient({
      account: privateKeyToAccount(verifierKey),
      chain,
      transport,
    }),
  };
}

export interface RegistrationTx {
  transactionHash: Hex;
  /** Null when the mirror node has not indexed the transaction yet. */
  transactionId: string | null;
}

export interface CreatorRegistryGateway {
  walletOfNullifier(nullifierHash: Hex): Promise<Address>;
  isCreator(wallet: Address): Promise<boolean>;
  registerCreator(nullifierHash: Hex, wallet: Address): Promise<RegistrationTx>;
}

export interface GatewayDeps {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  address: Address;
  transactionIdOf(hash: Hex): Promise<string | null>;
  receiptTimeoutMs?: number;
}

export function createCreatorRegistryGateway(deps: GatewayDeps): CreatorRegistryGateway {
  const { publicClient, walletClient, address, transactionIdOf } = deps;
  const contract = { address, abi: creatorRegistryAbi } as const;

  // One verifier key means one nonce sequence, so sends must not overlap.
  let queue: Promise<unknown> = Promise.resolve();
  function inOrder<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  }

  return {
    walletOfNullifier: (nullifierHash) =>
      publicClient.readContract({
        ...contract,
        functionName: 'walletOfNullifier',
        args: [nullifierHash],
      }),

    isCreator: (wallet) =>
      publicClient.readContract({ ...contract, functionName: 'isCreator', args: [wallet] }),

    registerCreator: async (nullifierHash, wallet) => {
      const transactionHash = await inOrder(async () => {
        const call = {
          ...contract,
          functionName: 'registerCreator',
          args: [nullifierHash, wallet],
          account: walletClient.account,
        } as const;

        // Reverts here, for free, on anything the contract would reject.
        const gas = await publicClient.estimateContractGas(call);
        const gasPrice = await publicClient.getGasPrice();
        const hash = await walletClient.writeContract({
          ...call,
          gas: (gas * 12n) / 10n,
          gasPrice,
          type: 'legacy',
        });

        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: deps.receiptTimeoutMs ?? 60_000,
        });
        if (receipt.status !== 'success') throw new Error('registerCreator reverted');
        return hash;
      });

      // Outside the queue: the nonce is settled, and a lagging mirror can take a while.
      return { transactionHash, transactionId: await transactionIdOf(transactionHash) };
    },
  };
}
