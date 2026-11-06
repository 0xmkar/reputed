import type { AgentDetail, ApiError } from '@reputed/shared';
import { ReputedError, type GateFailure } from './errors.ts';

export interface ReputedClientOptions {
  /** Base URL of the Reputed server, for example http://localhost:4000. */
  apiUrl: string;
  /** Override fetch, for tests or custom agents. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface VerifyOptions {
  /** Refuse agents scoring below this (0-100). */
  minScore?: number;
  /** Refuse agents that are not linked to a verified human. */
  humanBackedOnly?: boolean;
}

export type VerifyResult =
  | { ok: true; agent: AgentDetail }
  | { ok: false; reason: GateFailure; message: string; agent: AgentDetail };

const DECIMAL = /^\d+$/;

export class ReputedClient {
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: ReputedClientOptions) {
    this.#apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
  }

  /** Profile, score, tier, creator, creator score, credentials and reviews of one agent. */
  async getAgent(agentId: string | number | bigint): Promise<AgentDetail> {
    const id = String(agentId);
    if (!DECIMAL.test(id)) {
      throw new ReputedError('INVALID_ARGUMENT', `Agent IDs are decimal numbers, got "${id}".`);
    }
    return this.#getJson<AgentDetail>(`/api/agents/${id}`);
  }

  /**
   * A gate to run before paying or hiring an agent. Resolves with ok: false and a reason when the
   * agent fails the gate. Throws a ReputedError only when the check itself could not be made.
   */
  async verifyCounterparty(agentId: string | number | bigint, options: VerifyOptions = {}): Promise<VerifyResult> {
    const { minScore, humanBackedOnly = false } = options;
    if (minScore !== undefined && !(Number.isFinite(minScore) && minScore >= 0 && minScore <= 100)) {
      throw new ReputedError('INVALID_ARGUMENT', `minScore must be a number from 0 to 100, got ${String(minScore)}.`);
    }

    const agent = await this.getAgent(agentId);
    const fail = (reason: GateFailure, message: string): VerifyResult => ({ ok: false, reason, message, agent });

    if (agent.status === 'compromised') {
      return fail('AGENT_COMPROMISED', `Agent ${agent.agentId} was reported compromised.`);
    }
    if (humanBackedOnly && !agent.humanBacked) {
      return fail('NOT_HUMAN_BACKED', `Agent ${agent.agentId} is not linked to a verified human.`);
    }
    if (minScore !== undefined && agent.score.value < minScore) {
      return fail('SCORE_TOO_LOW', `Agent ${agent.agentId} scores ${agent.score.value}, below the minimum of ${minScore}.`);
    }
    return { ok: true, agent };
  }

  async #getJson<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#apiUrl}${path}`, { headers: { accept: 'application/json' } });
    } catch (cause) {
      throw new ReputedError('API_ERROR', `Could not reach the Reputed API at ${this.#apiUrl}.`, { cause });
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiError | null;
      if (res.status === 404) {
        throw new ReputedError('AGENT_NOT_FOUND', body?.message ?? 'No such agent.', { status: 404 });
      }
      if (body?.code === 'CHAIN_ERROR') {
        throw new ReputedError('CHAIN_ERROR', body.message, { status: res.status });
      }
      throw new ReputedError('API_ERROR', body?.message ?? `The Reputed API answered ${res.status}.`, { status: res.status });
    }

    try {
      return (await res.json()) as T;
    } catch (cause) {
      throw new ReputedError('API_ERROR', 'The Reputed API sent a response that is not valid JSON.', { status: res.status, cause });
    }
  }
}
