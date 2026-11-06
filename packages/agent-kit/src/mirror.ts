import type { Address, Hex } from 'viem';
import { REGISTERED, type TxLog } from '@reputed/shared';
import { ReputedAgentError } from './errors';

export interface MirrorAccount {
  account: string;
  evm_address: string | null;
  balance: { balance: number };
  max_automatic_token_associations: number;
}

export interface ContractResult {
  /** `SUCCESS`, `CONTRACT_REVERT_EXECUTED`, `INSUFFICIENT_GAS`, … */
  result: string;
  /** Revert data as hex, when the call reverted. */
  error_message: string | null;
  logs: { address: string; topics: string[]; data: string }[];
}

export interface RegisteredLog extends TxLog {
  transaction_hash?: string;
}

/** Thrown by `call` when the contract reverts, carrying the revert data. */
export class CallReverted extends Error {
  constructor(readonly data: Hex | null) {
    super('The contract call reverted.');
    this.name = 'CallReverted';
  }
}

export interface MirrorOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** How many times to try again on HTTP 429 and 5xx. Defaults to 4. */
  retries?: number;
}

/** register(string agentURI), the Identity Registry call that mints an agent. */
const REGISTER_URI_SELECTOR = '0xf2c298be';
/** Each lookup is one request to a rate-limited public node, so only the newest registrations are read. */
const MAX_REGISTRATION_LOOKUPS = 20;

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/** The few Mirror Node reads onboarding needs. Public nodes rate-limit per IP, so 429 backs off. */
export class MirrorClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #retries: number;

  constructor(options: MirrorOptions) {
    this.#base = `${options.baseUrl.replace(/\/+$/, '')}/api/v1`;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#retries = options.retries ?? 4;
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    let last: unknown;
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      try {
        const res = await this.#fetch(`${this.#base}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
        if (!RETRY_STATUSES.has(res.status)) return res;
        last = new Error(`Mirror Node answered ${res.status}`);
      } catch (error) {
        last = error;
      }
      if (attempt < this.#retries) await this.#sleep(500 * 2 ** attempt);
    }
    throw new ReputedAgentError('MIRROR_ERROR', 'Could not reach the Hedera Mirror Node. Check your network and try again.', { cause: last });
  }

  async #get<T>(path: string): Promise<T | null> {
    const res = await this.#request(path, { headers: { accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new ReputedAgentError('MIRROR_ERROR', `The Mirror Node answered ${res.status} for ${path.split('?')[0]}.`);
    return (await res.json()) as T;
  }

  getAccount(idOrAddress: string): Promise<MirrorAccount | null> {
    return this.#get<MirrorAccount>(`/accounts/${idOrAddress}`);
  }

  /** The 0.0.x ID of a contract, from its EVM address. */
  async getContractId(evmAddress: string): Promise<string | null> {
    const body = await this.#get<{ contract_id: string }>(`/contracts/${evmAddress}`);
    return body?.contract_id ?? null;
  }

  /** A read-only call, like eth_call. Throws CallReverted when the contract reverts. */
  async call(to: Address, data: Hex): Promise<Hex> {
    const res = await this.#request('/contracts/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ block: 'latest', to, data, estimate: false }),
    });
    const body = (await res.json().catch(() => null)) as
      | { result?: Hex; _status?: { messages?: { data?: Hex }[] } }
      | null;
    if (res.ok && body?.result) return body.result;
    if (res.status === 400 || res.status === 200) throw new CallReverted(body?._status?.messages?.[0]?.data ?? null);
    throw new ReputedAgentError('MIRROR_ERROR', `The Mirror Node answered ${res.status} to a contract read.`);
  }

  /** The result of a contract transaction, or null while the Mirror Node has not seen it yet. */
  getContractResult(transactionId: string): Promise<ContractResult | null> {
    return this.#get<ContractResult>(`/contracts/results/${transactionId}`);
  }

  /**
   * Registered logs of agents this account registered, newest first. The Mirror Node refuses topic
   * searches without a timestamp range, so this reads the account's own contract calls instead.
   */
  async registeredBy(identityRegistry: Address, owner: Address): Promise<RegisteredLog[]> {
    const list = await this.#get<{ results: { to: string | null; hash: string; result: string; function_parameters: string }[] }>(
      `/contracts/results?from=${owner}&order=desc&limit=100`,
    );
    const registry = identityRegistry.toLowerCase();
    const calls = (list?.results ?? [])
      .filter((call) => call.to?.toLowerCase() === registry && call.result === 'SUCCESS' && call.function_parameters.startsWith(REGISTER_URI_SELECTOR))
      .slice(0, MAX_REGISTRATION_LOOKUPS);

    const logs: RegisteredLog[] = [];
    for (const call of calls) {
      const detail = await this.getContractResult(call.hash);
      const log = detail?.logs.find((item) => item.address.toLowerCase() === registry && item.topics[0] === REGISTERED);
      if (log) logs.push({ ...log, data: log.data ?? '0x', transaction_hash: call.hash });
    }
    return logs;
  }

  /** True once the account holds (or has associated with) the token. */
  async isAssociated(accountId: string, tokenId: string): Promise<boolean> {
    const body = await this.#get<{ tokens: { token_id: string }[] }>(`/accounts/${accountId}/tokens?token.id=${tokenId}`);
    return (body?.tokens.length ?? 0) > 0;
  }
}
