import type { AgentDetail, ApiError } from '@reputed/shared';
import { ReputedError, type GateFailure } from './errors.ts';

// A small typed client over the read endpoints. Two kinds of outcome are kept apart on purpose: a gate
// decision ("do not pay this agent") is a returned value, while anything that stopped the check itself
// (bad input, unreachable API, 404) throws a ReputedError with a code. Responses are the shared API
// types, so the server's contract is the client's type.

export interface ReputedClientOptions {
  /** Base URL of the Reputed server, for example http://localhost:4000. */
  apiUrl: string;
  /** Override fetch, for tests or custom agents. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Give up on a request after this many milliseconds. Defaults to 10000. */
  timeoutMs?: number;
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
const DEFAULT_TIMEOUT_MS = 10_000;

export class ReputedClient {
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ReputedClientOptions) {
    this.#apiUrl = options.apiUrl.replace(/\/+$/, '');
    // Bound to globalThis: calling the global fetch with another `this` throws "Illegal invocation" in browsers.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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

    // Checked in order of severity. Compromised is refused regardless of options; a score equal to minScore passes.
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
    // One deadline covers connecting and reading the body: a hung API must not block a payment gate forever.
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const unreachable = (cause: unknown, status?: number) =>
      new ReputedError(
        'API_ERROR',
        isTimeout(cause)
          ? `The Reputed API at ${this.#apiUrl} did not answer within ${this.#timeoutMs} ms.`
          : `Could not reach the Reputed API at ${this.#apiUrl}.`,
        { status, cause },
      );

    let res: Response;
    try {
      res = await this.#fetch(`${this.#apiUrl}${path}`, { headers: { accept: 'application/json' }, signal });
    } catch (cause) {
      throw unreachable(cause);
    }

    if (!res.ok) {
      // The body may not be JSON (a proxy error page), so it is optional.
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
      if (isTimeout(cause)) throw unreachable(cause, res.status);
      throw new ReputedError('API_ERROR', 'The Reputed API sent a response that is not valid JSON.', { status: res.status, cause });
    }
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}
