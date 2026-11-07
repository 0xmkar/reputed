import { grantAddress, newApiKey, type AgentFileResponse } from '@reputed/shared';
import { getAddress } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReputedAgentError, type ReputedAgentErrorCode } from '../src/errors';
import { onboard, type AgentProfile, type OnboardDeps } from '../src/onboard';
import { MemoryStateStore } from '../src/state';
import { ACCOUNT, AGENT_EVM, CREATOR, FakeChain, IDENTITY, OTHER_CREATOR, REGISTRY, TOKEN } from './fakeChain';

const API_KEY = newApiKey('test');
const PROFILE: AgentProfile = {
  name: 'Trip planner',
  description: 'Plans trips',
  endpoints: { a2a: 'https://trips.example/a2a' },
};

let chain: FakeChain;
let state: MemoryStateStore;

function deps(over: Partial<OnboardDeps> = {}): OnboardDeps {
  return {
    gateway: chain,
    mirror: chain,
    config: {
      network: 'hedera-testnet',
      chainId: 296,
      identityRegistry: IDENTITY,
      creatorRegistry: REGISTRY,
      credentialTokenId: TOKEN,
      mirrorNode: 'https://mirror.test',
    },
    apiKey: API_KEY,
    profile: PROFILE,
    state,
    postAgentFile: async (file): Promise<AgentFileResponse> => {
      chain.files.push(file);
      return { uri: `data:application/json;base64,${Buffer.from(JSON.stringify(file)).toString('base64')}`, hash: '0x00' };
    },
    now: () => chain.now,
    sleep: async () => {
      chain.now += 1_500;
    },
    log: () => {},
    ...over,
  };
}

async function failure(promise: Promise<unknown>): Promise<ReputedAgentError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReputedAgentError);
    return error as ReputedAgentError;
  }
  throw new Error('expected onboarding to fail');
}

const codeOf = async (promise: Promise<unknown>): Promise<ReputedAgentErrorCode> => (await failure(promise)).code;

beforeEach(() => {
  chain = new FakeChain();
  chain.addGrant(grantAddress(API_KEY));
  state = new MemoryStateStore();
});

describe('first run', () => {
  it('registers, associates, links and returns the identity', async () => {
    const result = await onboard(deps());

    expect(result).toMatchObject({ agentId: '0', owner: getAddress(AGENT_EVM), creator: CREATOR, serial: 1 });
    expect(chain.sent).toEqual(['register', 'associate', 'link']);
    expect(chain.linkedTo.get('0')).toBe(CREATOR);
    expect(chain.grants.get(grantAddress(API_KEY))!.used).toBe(1);
    expect(result.steps).toHaveLength(3);
  });

  it('builds the registration file from the profile', async () => {
    await onboard(deps({ profile: { ...PROFILE, tags: ['travel'], x402PriceHbar: 2 } }));
    expect(chain.files[0]).toMatchObject({
      name: 'Trip planner',
      description: 'Plans trips',
      services: [{ name: 'A2A', endpoint: 'https://trips.example/a2a' }],
      x402Support: true,
      tags: ['travel'],
    });
  });

  it('skips the association for an account with free automatic-association slots', async () => {
    chain.maxAutoAssociations = -1;
    await onboard(deps());
    expect(chain.sent).toEqual(['register', 'link']);
  });

  it('associates and retries once when the slots turn out to be used up', async () => {
    chain.maxAutoAssociations = 3;
    chain.slotsExhausted = true;
    await onboard(deps());
    expect(chain.sent).toEqual(['register', 'link', 'associate', 'link']);
    expect(chain.linkedTo.get('0')).toBe(CREATOR);
  });
});

describe('running again', () => {
  it('sends nothing once everything is in place', async () => {
    await onboard(deps());
    chain.sent = [];

    const again = await onboard(deps());
    expect(chain.sent).toEqual([]);
    expect(again).toMatchObject({ agentId: '0', creator: CREATOR, serial: 1, steps: [] });
  });

  it('does not register twice when the state file is lost', async () => {
    await onboard(deps());
    chain.sent = [];
    state = new MemoryStateStore();

    const again = await onboard(deps());
    expect(chain.sent).toEqual([]);
    expect(again.agentId).toBe('0');
    expect(chain.agents.size).toBe(1);
  });

  it('registers a second agent for a different name', async () => {
    await onboard(deps());
    state = new MemoryStateStore();

    const second = await onboard(deps({ profile: { ...PROFILE, name: 'Other bot' } }));
    expect(second.agentId).toBe('1');
    expect(chain.agents.size).toBe(2);
    expect(chain.grants.get(grantAddress(API_KEY))!.used).toBe(2);
  });
});

describe('interrupted runs', () => {
  it('resumes at the link when the process dies after registering', async () => {
    chain.failOnSend = 2; // register is send 1, the association is not a contract send, the link is send 2
    await expect(onboard(deps())).rejects.toThrow('connection reset');
    expect(chain.sent).toEqual(['register', 'associate']);
    expect(chain.agents.size).toBe(1);

    chain.failOnSend = null;
    const result = await onboard(deps());
    expect(result.agentId).toBe('0');
    expect(chain.agents.size).toBe(1);
    expect(chain.linkedTo.get('0')).toBe(CREATOR);
  });

  it('finds a registration whose transaction ID was never written down', async () => {
    // The process stopped between writing the URI down and saving the transaction ID.
    const uri = `data:application/json;base64,${Buffer.from(JSON.stringify({ name: 'Trip planner' })).toString('base64')}`;
    chain.agents.set('0', { owner: AGENT_EVM, uri });
    state.save(`296:${REGISTRY.toLowerCase()}:${ACCOUNT}`, { pendingRegistration: { uri, startedAt: chain.now } });

    const result = await onboard(deps());
    expect(result.agentId).toBe('0');
    expect(chain.sent).not.toContain('register');
  });

  it('registers again if a pending transaction never reached consensus', async () => {
    const uri = 'data:application/json;base64,e30=';
    state.save(`296:${REGISTRY.toLowerCase()}:${ACCOUNT}`, { pendingRegistration: { uri, startedAt: chain.now } });

    const result = await onboard(deps());
    expect(chain.sent[0]).toBe('register');
    expect(result.agentId).toBe('0');
  });
});

describe('API key problems', () => {
  it('names a key that was never authorized on-chain', async () => {
    chain.grants.clear();
    expect(await codeOf(onboard(deps()))).toBe('GRANT_NOT_FOUND');
    expect(chain.sent).toEqual([]);
  });

  it.each([
    ['GRANT_REVOKED', { revoked: true }],
    ['GRANT_EXPIRED', { expiresAt: 1_000n }],
    ['GRANT_EXHAUSTED', { maxAgents: 1, used: 1 }],
  ] as const)('refuses before sending anything: %s', async (code, over) => {
    chain.addGrant(grantAddress(API_KEY), over);
    expect(await codeOf(onboard(deps()))).toBe(code);
    expect(chain.sent).toEqual([]);
  });

  it('refuses a dead key for an agent that is registered but not linked yet', async () => {
    chain.agents.set('0', { owner: AGENT_EVM, uri: `data:application/json;base64,${Buffer.from(JSON.stringify({ name: PROFILE.name })).toString('base64')}` });
    chain.addGrant(grantAddress(API_KEY), { revoked: true });
    expect(await codeOf(onboard(deps()))).toBe('GRANT_REVOKED');
    expect(chain.sent).toEqual([]);
  });

  it('does not mind a revoked key once the agent is linked', async () => {
    await onboard(deps());
    chain.grants.get(grantAddress(API_KEY))!.revoked = true;
    await expect(onboard(deps())).resolves.toMatchObject({ agentId: '0' });
  });

  it('refuses an agent that belongs to another creator', async () => {
    await onboard(deps());
    chain.linkedTo.set('0', OTHER_CREATOR);
    expect(await codeOf(onboard(deps()))).toBe('LINKED_TO_OTHER_CREATOR');
  });
});

describe('account problems', () => {
  it('says how much HBAR is missing, before anything is sent', async () => {
    chain.hbar = 0.5;
    const error = await failure(onboard(deps()));
    expect(error.code).toBe('INSUFFICIENT_HBAR');
    expect(error.message).toContain(ACCOUNT);
    expect(chain.sent).toEqual([]);
    expect(state.load(`296:${REGISTRY.toLowerCase()}:${ACCOUNT}`).pendingRegistration).toBeUndefined();
  });

  it('refuses an agentId the account does not own', async () => {
    chain.agents.set('9', { owner: '0x9999999999999999999999999999999999999999', uri: 'x' });
    expect(await codeOf(onboard(deps({ agentId: '9' })))).toBe('OWNER_MISMATCH');
    expect(await codeOf(onboard(deps({ agentId: '77' })))).toBe('OWNER_MISMATCH');
  });

  it('links an agentId the account already registered', async () => {
    chain.agents.set('3', { owner: AGENT_EVM, uri: 'x' });
    const result = await onboard(deps({ agentId: '3' }));
    expect(result.agentId).toBe('3');
    expect(chain.sent).not.toContain('register');
  });

  it('refuses a registry the server has not configured', async () => {
    const base = deps();
    expect(await codeOf(onboard({ ...base, config: { ...base.config, creatorRegistry: null } }))).toBe('NOT_CONFIGURED');
  });
});
