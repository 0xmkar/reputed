import { encodeAbiParameters, encodeEventTopics, getAddress } from 'viem';
import { identityRegistryAbi } from '@reputed/shared';
import { describe, expect, it } from 'vitest';
import { MirrorClient } from '../src/mirror';
import { AGENT_EVM, IDENTITY } from './fakeChain';

function registeredLog(agentId: bigint, uri: string) {
  return {
    address: IDENTITY.toLowerCase(),
    topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: 'Registered', args: { agentId, owner: AGENT_EVM } }) as string[],
    data: encodeAbiParameters([{ type: 'string' }], [uri]),
  };
}

function client(routes: Record<string, unknown>) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const key = Object.keys(routes).find((route) => url.includes(route));
    return key ? new Response(JSON.stringify(routes[key])) : new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { mirror: new MirrorClient({ baseUrl: 'https://mirror.test', fetch: fetchImpl, sleep: async () => {} }), urls };
}

describe('registeredBy', () => {
  it('reads the account’s own register calls and never searches topics', async () => {
    const { mirror, urls } = client({
      '/contracts/results?from=': {
        results: [
          { to: IDENTITY.toLowerCase(), hash: '0xaaa', result: 'SUCCESS', function_parameters: '0xf2c298be0000' },
          { to: IDENTITY.toLowerCase(), hash: '0xbbb', result: 'SUCCESS', function_parameters: '0x55d48fe10000' },
          { to: '0x4444444444444444444444444444444444444444', hash: '0xccc', result: 'SUCCESS', function_parameters: '0xf2c298be0000' },
          { to: IDENTITY.toLowerCase(), hash: '0xddd', result: 'CONTRACT_REVERT_EXECUTED', function_parameters: '0xf2c298be0000' },
        ],
      },
      '/contracts/results/0xaaa': { result: 'SUCCESS', error_message: null, logs: [registeredLog(5n, 'data:x')] },
    });

    const logs = await mirror.registeredBy(IDENTITY, getAddress(AGENT_EVM));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.transaction_hash).toBe('0xaaa');
    expect(urls.some((url) => url.includes('topic'))).toBe(false);
    // Only the one successful register(string) call to the Identity Registry was opened.
    expect(urls.filter((url) => url.includes('/contracts/results/'))).toEqual(['https://mirror.test/api/v1/contracts/results/0xaaa']);
  });

  it('is empty for an account that has sent nothing', async () => {
    const { mirror } = client({});
    expect(await mirror.registeredBy(IDENTITY, getAddress(AGENT_EVM))).toEqual([]);
  });
});
