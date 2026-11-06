import { newApiKey } from '@reputed/shared';
import { PrivateKey, Client } from '@hiero-ledger/sdk';
import { describe, expect, it } from 'vitest';
import { ReputedAgentError } from '../src/errors';
import { Reputed } from '../src/reputed';

const profile = { name: 'Bot', endpoints: { web: 'https://bot.example' } };

function clientWithOperator(): Client {
  return Client.forTestnet().setOperator('0.0.5000', PrivateKey.generateECDSA());
}

async function code(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReputedAgentError);
    return (error as ReputedAgentError).code;
  }
  return 'none';
}

describe('Reputed.connect', () => {
  it('needs an API URL', async () => {
    const saved = process.env['REPUTED_API_URL'];
    delete process.env['REPUTED_API_URL'];
    try {
      expect(await code(Reputed.connect({ client: clientWithOperator(), apiKey: newApiKey(), agent: profile, state: false }))).toBe('NOT_CONFIGURED');
    } finally {
      if (saved !== undefined) process.env['REPUTED_API_URL'] = saved;
    }
  });

  it('rejects something that is not an API key before any request', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch;
    const result = await code(
      Reputed.connect({ client: clientWithOperator(), apiKey: 'sk-not-ours', agent: profile, apiUrl: 'http://api.test', state: false, fetch: fetchImpl }),
    );
    expect(result).toBe('INVALID_API_KEY');
    expect(called).toBe(false);
  });

  it('does not echo the key in the error', async () => {
    const key = 'rpk_test_SECRETSECRETSECRET';
    try {
      await Reputed.connect({ client: clientWithOperator(), apiKey: key, agent: profile, apiUrl: 'http://api.test', state: false });
    } catch (error) {
      expect(String(error)).not.toContain('SECRETSECRET');
    }
  });

  it('needs a Client with an operator', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ network: 'hedera-testnet', chainId: 296, identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e', creatorRegistry: '0x4444444444444444444444444444444444444444', credentialTokenId: '0.0.700', mirrorNode: 'https://mirror.test' }))) as typeof fetch;
    expect(
      await code(Reputed.connect({ client: Client.forTestnet(), apiKey: newApiKey(), agent: profile, apiUrl: 'http://api.test', state: false, fetch: fetchImpl })),
    ).toBe('NO_OPERATOR');
  });

  it('reports an unreachable API', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(
      await code(Reputed.connect({ client: clientWithOperator(), apiKey: newApiKey(), agent: profile, apiUrl: 'http://api.test', state: false, fetch: fetchImpl })),
    ).toBe('API_ERROR');
  });
});
