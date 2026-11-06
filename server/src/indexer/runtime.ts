import { SCORING_CONFIG, type ScoringConfig } from '../scoring/config.ts';
import { computeScores } from '../scoring/score.ts';
import { buildSnapshot, computeInputsHash, epochEnd } from '../scoring/snapshot.ts';
import type { ConsensusTimestamp } from '../scoring/time.ts';
import type { ScoreResult, Snapshot } from '../scoring/types.ts';
import { enrichState } from './enrich.ts';
import { foldEvents, type ChainState } from './fold.ts';
import { ingestAll, type LogSource } from './ingest.ts';
import { buildInputs, scoringScope } from './inputs.ts';
import { MirrorClient } from './mirror.ts';
import { loadScorerSettings, type ScorerSettings } from './settings.ts';
import { Store } from './store.ts';

const LIVE_AS_OF = 'live_as_of';

export interface LiveView {
  asOf: ConsensusTimestamp;
  state: ChainState;
  result: ScoreResult;
}

export interface BuiltEpoch {
  snapshot: Snapshot;
  /** Reviews whose facts are not cached yet: the epoch must not be published until this is 0. */
  pending: number;
}

export interface RuntimeDeps {
  store: Store;
  mirror: MirrorClient;
  settings: ScorerSettings;
  config?: ScoringConfig;
  fetch?: typeof fetch;
}

/**
 * Two views of one pure computation. The epoch snapshot uses a fixed boundary and only linked
 * agents, so anyone can reproduce it. The live view uses the mirror's latest consensus time and
 * also agents someone asked for, so a new review shows on the page before the next epoch.
 */
export class ScorerRuntime {
  readonly store: Store;
  readonly mirror: MirrorClient;
  readonly settings: ScorerSettings;
  readonly config: ScoringConfig;
  private readonly fetchImpl: typeof fetch | undefined;
  private live: LiveView | null = null;
  /** Reviews whose last lookup failed: held out of both views until a sync resolves them. */
  private unresolved: Set<string> = new Set();

  constructor(deps: RuntimeDeps) {
    this.store = deps.store;
    this.mirror = deps.mirror;
    this.settings = deps.settings;
    this.config = deps.config ?? SCORING_CONFIG;
    this.fetchImpl = deps.fetch;

    const { identityRegistry, reputationRegistry, creatorRegistry } = this.settings;
    const addresses = [
      ['identity', identityRegistry],
      ['reputation', reputationRegistry],
      ['creatorRegistry', creatorRegistry],
    ] as const;
    for (const [source, address] of addresses) {
      if (this.store.bindSource(source, address)) {
        console.warn(`scorer: the ${source} address changed, re-reading its events from the start`);
      }
    }
  }

  private sources(): LogSource[] {
    const { identityRegistry, reputationRegistry, creatorRegistry } = this.settings;
    return [
      { source: 'identity', address: identityRegistry },
      { source: 'reputation', address: reputationRegistry },
      ...(creatorRegistry
        ? [{ source: 'creatorRegistry' as const, address: creatorRegistry }]
        : []),
    ];
  }

  private enrichOptions(asOf: ConsensusTimestamp) {
    return {
      asOf,
      reviewsTopicId: this.settings.reviewsTopicId,
      ipfsGateway: this.settings.ipfsGateway,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    };
  }

  /**
   * Reads the mirror's consensus time before ingesting, so every log at or below the returned time
   * has been seen. Throws when the mirror is down, leaving the previous view in place. A failure
   * on one review does not throw: it holds that review, and so any epoch needing it, back.
   */
  async sync(): Promise<ConsensusTimestamp> {
    const asOf = await this.mirror.latestConsensusTimestamp();
    await ingestAll(this.store, this.mirror, this.sources());

    const state = foldEvents(this.store.eventsUpTo(asOf));
    const scope = scoringScope(state, this.store.trackedAgents());
    this.unresolved = await enrichState(
      this.store,
      this.mirror,
      state,
      scope,
      this.enrichOptions(asOf),
    );

    this.store.setMeta(LIVE_AS_OF, asOf);
    this.live = this.buildLive(asOf);
    return asOf;
  }

  private buildLive(asOf: ConsensusTimestamp): LiveView {
    const state = foldEvents(this.store.eventsUpTo(asOf));
    const { inputs } = buildInputs(state, this.store, {
      asOf,
      reviewsTopicId: this.settings.reviewsTopicId,
      extraAgentIds: this.store.trackedAgents(),
      unresolved: this.unresolved,
    });
    return { asOf, state, result: computeScores(inputs, this.config, asOf) };
  }

  /** Null before the first sync has ever completed. */
  view(): LiveView | null {
    if (this.live) return this.live;
    const asOf = this.store.getMeta(LIVE_AS_OF);
    if (asOf) this.live = this.buildLive(asOf);
    return this.live;
  }

  /** Starts scoring an agent nobody linked, because someone asked for it. False if it does not exist. */
  async trackAgent(agentId: string): Promise<boolean> {
    const view = this.view();
    if (!view?.state.identities.has(agentId)) return false;
    if (view.result.agents.some((agent) => agent.agentId === agentId)) return true;

    const scope = new Set([agentId]);
    const failed = await enrichState(
      this.store,
      this.mirror,
      view.state,
      scope,
      this.enrichOptions(view.asOf),
    );
    for (const key of failed) this.unresolved.add(key);
    this.store.trackAgent(agentId);
    this.live = this.buildLive(view.asOf);
    return true;
  }

  buildEpoch(epoch: number): BuiltEpoch {
    const asOf = epochEnd(epoch, this.config);
    const state = foldEvents(this.store.eventsUpTo(asOf));
    const { inputs, pending } = buildInputs(state, this.store, {
      asOf,
      reviewsTopicId: this.settings.reviewsTopicId,
      unresolved: this.unresolved,
    });
    const result = computeScores(inputs, this.config, asOf);
    const inputsHash = computeInputsHash(inputs, this.config, asOf);
    return { snapshot: buildSnapshot(epoch, inputsHash, result), pending };
  }
}

let shared: ScorerRuntime | undefined;

/** One store per process: the read routes and the epoch loop must see the same cache. */
export function getScorerRuntime(): ScorerRuntime {
  if (!shared) {
    const settings = loadScorerSettings();
    shared = new ScorerRuntime({
      settings,
      store: new Store(settings.dbPath),
      mirror: new MirrorClient({ baseUrl: settings.mirrorNode }),
      config: settings.epochSeconds
        ? { ...SCORING_CONFIG, epochSeconds: settings.epochSeconds }
        : SCORING_CONFIG,
    });
  }
  return shared;
}
