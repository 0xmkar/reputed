import { describe, expect, it, vi } from 'vitest';
import { createCreatorRegistryGateway, hederaChain, type GatewayDeps } from '../src/chain.ts';
import { createMirror } from '../src/mirror.ts';
import { jsonResponse } from './helpers.ts';

const HASH = `0x${'ab'.repeat(32)}` as const;
const NULLIFIER = `0x${'01'.repeat(32)}` as const;
const WALLET = '0x1111111111111111111111111111111111111111';

function clients(status: 'success' | 'reverted' = 'success') {
  const order: string[] = [];
  const publicClient = {
    estimateContractGas: vi.fn(async () => 100_000n),
    getGasPrice: vi.fn(async () => 1_300_000_000_000n),
    waitForTransactionReceipt: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('receipt');
      return { status };
    }),
  };
  const walletClient = {
    account: { address: WALLET },
    writeContract: vi.fn(async () => {
      order.push('send');
      return HASH;
    }),
  };
  const gateway = createCreatorRegistryGateway({
    publicClient: publicClient as unknown as GatewayDeps['publicClient'],
    walletClient: walletClient as unknown as GatewayDeps['walletClient'],
    address: WALLET,
    transactionIdOf: async () => '0.0.1-1-1',
  });
  return { gateway, publicClient, walletClient, order };
}

describe('hederaChain', () => {
  it('is chain 296 from the shared constants', () => {
    expect(hederaChain().id).toBe(296);
    expect(hederaChain().rpcUrls.default.http[0]).toBe('https://testnet.hashio.io/api');
  });
});

describe('createCreatorRegistryGateway', () => {
  it('returns both transaction IDs', async () => {
    const { gateway } = clients();
    await expect(gateway.registerCreator(NULLIFIER, WALLET)).resolves.toEqual({
      transactionHash: HASH,
      transactionId: '0.0.1-1-1',
    });
  });

  it('adds a 20% gas margin and sends a legacy transaction at the relay gas price', async () => {
    const { gateway, walletClient } = clients();
    await gateway.registerCreator(NULLIFIER, WALLET);
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 120_000n, gasPrice: 1_300_000_000_000n, type: 'legacy' }),
    );
  });

  it('never overlaps two sends from the verifier key', async () => {
    const { gateway, order } = clients();
    await Promise.all([
      gateway.registerCreator(NULLIFIER, WALLET),
      gateway.registerCreator(NULLIFIER, WALLET),
      gateway.registerCreator(NULLIFIER, WALLET),
    ]);
    expect(order).toEqual(['send', 'receipt', 'send', 'receipt', 'send', 'receipt']);
  });

  it('keeps working after a failed send', async () => {
    const { gateway, walletClient } = clients();
    walletClient.writeContract.mockRejectedValueOnce(new Error('nope'));
    const [first, second] = await Promise.allSettled([
      gateway.registerCreator(NULLIFIER, WALLET),
      gateway.registerCreator(NULLIFIER, WALLET),
    ]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
  });

  it('sends nothing when gas estimation shows the call would revert', async () => {
    const { gateway, publicClient, walletClient } = clients();
    publicClient.estimateContractGas.mockRejectedValueOnce(new Error('execution reverted'));
    await expect(gateway.registerCreator(NULLIFIER, WALLET)).rejects.toThrow();
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it('treats a reverted receipt as a failure', async () => {
    const { gateway } = clients('reverted');
    await expect(gateway.registerCreator(NULLIFIER, WALLET)).rejects.toThrow(/reverted/);
  });
});

describe('createCreatorRegistryGateway: mirror lookups', () => {
  it('releases the nonce queue before the mirror lookup', async () => {
    const { publicClient, walletClient } = clients();
    let finishLookup!: (id: string) => void;
    const lookup = new Promise<string>((resolve) => (finishLookup = resolve));
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => (lookupStarted = resolve));

    const gateway = createCreatorRegistryGateway({
      publicClient: publicClient as unknown as GatewayDeps['publicClient'],
      walletClient: walletClient as unknown as GatewayDeps['walletClient'],
      address: WALLET,
      transactionIdOf: () => {
        lookupStarted();
        return lookup;
      },
    });

    const first = gateway.registerCreator(NULLIFIER, WALLET);
    await started;
    const second = gateway.registerCreator(NULLIFIER, WALLET);
    await vi.waitFor(() => expect(walletClient.writeContract).toHaveBeenCalledTimes(2));

    finishLookup('0.0.1-1-1');
    await expect(first).resolves.toMatchObject({ transactionId: '0.0.1-1-1' });
    await expect(second).resolves.toMatchObject({ transactionId: '0.0.1-1-1' });
  });
});

describe('createMirror', () => {
  // Shapes captured from testnet on 2026-11-06.
  const routes = (url: string) => {
    if (url.includes('/contracts/results/')) {
      return jsonResponse(200, { timestamp: '1793960518.325459104', hash: HASH });
    }
    return jsonResponse(200, {
      transactions: [{ transaction_id: '0.0.7314364-1793960511-841191137', name: 'ETHEREUMTRANSACTION' }],
    });
  };

  it('resolves an EVM hash to the Hedera transaction ID', async () => {
    const calls: string[] = [];
    const mirror = createMirror('https://mirror.test', {
      fetch: (async (url: string) => {
        calls.push(url);
        return routes(url);
      }) as unknown as typeof fetch,
    });

    await expect(mirror.transactionIdOf(HASH)).resolves.toBe('0.0.7314364-1793960511-841191137');
    expect(calls[1]).toContain('timestamp=1793960518.325459104');
  });

  it('retries while the mirror lags, including through 429s', async () => {
    let call = 0;
    const mirror = createMirror('https://mirror.test', {
      delayMs: 1,
      fetch: (async (url: string) => {
        call++;
        if (call === 1) return jsonResponse(404, {});
        if (call === 2) return jsonResponse(429, {});
        return routes(url);
      }) as unknown as typeof fetch,
    });
    await expect(mirror.transactionIdOf(HASH)).resolves.toBe('0.0.7314364-1793960511-841191137');
  });

  it('gives up with null rather than failing a transaction that landed', async () => {
    const mirror = createMirror('https://mirror.test', {
      attempts: 2,
      delayMs: 1,
      fetch: (async () => jsonResponse(404, {})) as unknown as typeof fetch,
    });
    await expect(mirror.transactionIdOf(HASH)).resolves.toBeNull();
  });

  it('returns null for an unknown account and the ID for a known one', async () => {
    const mirror = createMirror('https://mirror.test', {
      fetch: (async (url: string) =>
        url.endsWith(WALLET)
          ? jsonResponse(200, { account: '0.0.77' })
          : jsonResponse(404, {})) as unknown as typeof fetch,
    });
    await expect(mirror.accountIdOf(WALLET)).resolves.toBe('0.0.77');
    await expect(
      mirror.accountIdOf('0x2222222222222222222222222222222222222222'),
    ).resolves.toBeNull();
  });
});
