import type { Client } from '@hiero-ledger/sdk';
import type { Plugin } from '@hashgraph/hedera-agent-kit';
import { InvalidApiKeyError, parseApiKey, type AgentDetail, type ApiError, type ConfigResponse } from '@reputed/shared';
import { ReputedClient, type VerifyOptions, type VerifyResult } from '@reputed/sdk';
import type { Address } from 'viem';
import { ReputedAgentError } from './errors';
import { clientGateway } from './gateway';
import { MirrorClient } from './mirror';
import { onboard, type AgentProfile, type OnboardResult } from './onboard';
import { createReputedPlugin } from './plugin';
import { FileStateStore, MemoryStateStore, type StateStore } from './state';

export interface ReputedConnectOptions {
  /** The agent's Hedera client. Its operator account becomes the agent's on-chain identity. */
  client: Client;
  /** From the Reputed dashboard: rpk_test_… */
  apiKey: string;
  /** What the agent is and how to reach it. Used only the first time, to register it. */
  agent: AgentProfile;
  /** The Reputed API. Defaults to the REPUTED_API_URL environment variable. */
  apiUrl?: string;
  /** Link an agent you already registered instead of registering a new one. */
  agentId?: string | number | bigint;
  /**
   * Where progress is written so an interrupted run carries on instead of starting over.
   * A file path (default `.reputed/state.json`), `false` to keep it in memory, or your own store.
   */
  state?: string | false | StateStore;
  /** Progress messages while onboarding. Silent by default. */
  logger?: (message: string) => void;
  fetch?: typeof fetch;
}

export const DEFAULT_STATE_FILE = '.reputed/state.json';

async function apiJson<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (cause) {
    throw new ReputedAgentError('API_ERROR', `Could not reach the Reputed API at ${new URL(url).origin}.`, { cause });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ReputedAgentError('API_ERROR', body?.message ?? `The Reputed API answered ${res.status}.`);
  }
  return (await res.json()) as T;
}

/** An agent with a Reputed identity. Create one with `Reputed.connect`. */
export class Reputed {
  /** Add this to the Hedera Agent Kit's `configuration.plugins`. */
  readonly plugin: Plugin;

  private constructor(
    readonly client: ReputedClient,
    readonly onboarding: OnboardResult,
  ) {
    this.plugin = createReputedPlugin(this);
  }

  get agentId(): string {
    return this.onboarding.agentId;
  }
  /** The verified human behind the API key. */
  get creator(): Address {
    return this.onboarding.creator;
  }
  /** The agent account's EVM address. */
  get owner(): Address {
    return this.onboarding.owner;
  }

  /**
   * Registers the agent, links it to its human and receives its credential, the first time. Every
   * later call finds all of that in place and only looks it up. Safe to run again after a crash.
   */
  static async connect(options: ReputedConnectOptions): Promise<Reputed> {
    const apiUrl = (options.apiUrl ?? process.env['REPUTED_API_URL'])?.replace(/\/+$/, '');
    if (!apiUrl) {
      throw new ReputedAgentError('NOT_CONFIGURED', 'Pass apiUrl or set REPUTED_API_URL to the address of the Reputed API.');
    }
    try {
      parseApiKey(options.apiKey);
    } catch (error) {
      if (error instanceof InvalidApiKeyError) throw new ReputedAgentError('INVALID_API_KEY', error.message);
      throw error;
    }
    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

    const config = await apiJson<ConfigResponse>(fetchImpl, `${apiUrl}/api/config`, { headers: { accept: 'application/json' } });
    const state: StateStore =
      options.state === false
        ? new MemoryStateStore()
        : typeof options.state === 'object'
          ? options.state
          : new FileStateStore(options.state ?? DEFAULT_STATE_FILE);

    const result = await onboard({
      gateway: clientGateway(options.client),
      mirror: new MirrorClient({ baseUrl: config.mirrorNode, fetch: fetchImpl }),
      config,
      apiKey: options.apiKey,
      profile: options.agent,
      ...(options.agentId !== undefined ? { agentId: String(options.agentId) } : {}),
      state,
      postAgentFile: (file) =>
        apiJson(fetchImpl, `${apiUrl}/api/agent-file`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(file),
        }),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: options.logger ?? (() => {}),
    });

    return new Reputed(new ReputedClient({ apiUrl, fetch: fetchImpl }), result);
  }

  /** This agent's current score, tier, credentials and reviews. */
  reputation(): Promise<AgentDetail> {
    return this.client.getAgent(this.agentId);
  }

  /** Check another agent before paying or hiring it. */
  verifyCounterparty(agentId: string | number | bigint, options?: VerifyOptions): Promise<VerifyResult> {
    return this.client.verifyCounterparty(agentId, options);
  }
}
