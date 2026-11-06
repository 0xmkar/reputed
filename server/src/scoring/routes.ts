import {
  hashscan,
  type Address,
  type AgentDetail,
  type AgentListResponse,
  type AgentSummary,
  type Credential,
  type CreatorDetail,
  type Review,
  type ReviewResponse,
} from '@reputed/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiHttpError, badRequest, chainError } from '../errors.ts';
import { parseAgentProfile, type AgentProfile } from '../indexer/agentFile.ts';
import { feedbackKey } from '../indexer/fold.ts';
import { agentInput } from '../indexer/inputs.ts';
import { getScorerRuntime, type LiveView, type ScorerRuntime } from '../indexer/runtime.ts';
import { toIso } from './time.ts';
import type { AgentResult, ClassifiedReview } from './types.ts';
import { agentWalletAt, ownerAt } from './wallets.ts';

const notFound = (what: string) => new ApiHttpError(404, 'NOT_FOUND', `${what} not found.`);

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  humanBacked: z.enum(['true', 'false']).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
});

function currentWallet(view: LiveView, agentId: string): Address | null {
  return view.state.identities.get(agentId)?.walletHistory.at(-1)?.wallet ?? null;
}

function operatorChanged(view: LiveView, agentId: string): boolean {
  const link = view.state.links.get(agentId);
  const owner = view.state.identities.get(agentId)?.owner;
  return Boolean(link && owner && owner !== link.creator);
}

/** A report on any agent recorded on the wallet voids it, unless it is a creator wallet. */
function walletVoided(view: LiveView, wallet: Address): boolean {
  if (view.state.creators.has(wallet)) return false;
  return [...view.state.links.values()].some(
    (link) =>
      view.state.compromisedAt.has(link.agentId) &&
      link.wallets.some((vouched) => vouched.wallet === wallet),
  );
}

/** The agent-level answer to CreatorRegistry.isHumanBacked, so the badge never outlives the link. */
function isHumanBacked(view: LiveView, agentId: string): boolean {
  const link = view.state.links.get(agentId);
  const wallet = currentWallet(view, agentId);
  return (
    link !== undefined &&
    wallet !== null &&
    !view.state.compromisedAt.has(agentId) &&
    !operatorChanged(view, agentId) &&
    link.wallets.some((vouched) => vouched.wallet === wallet) &&
    !walletVoided(view, wallet)
  );
}

function profileOf(runtime: ScorerRuntime, view: LiveView, agentId: string): AgentProfile {
  const uri = view.state.identities.get(agentId)?.agentUri;
  return parseAgentProfile((uri && runtime.store.agentFile(uri)?.body) || null);
}

function toSummary(
  runtime: ScorerRuntime,
  view: LiveView,
  result: AgentResult,
  profile: AgentProfile,
): AgentSummary {
  const { agentId, creator } = result;
  const identity = view.state.identities.get(agentId);
  const registeredAt = identity?.registeredAt ?? view.state.links.get(agentId)?.linkedAt;
  const creatorResult = creator
    ? view.result.creators.find((item) => item.creator === creator)
    : undefined;
  return {
    agentId,
    name: profile.name ?? `Agent #${agentId}`,
    description: profile.description ?? '',
    ...(profile.image ? { image: profile.image } : {}),
    tags: profile.tags,
    owner: identity?.owner ?? creator ?? ZERO_ADDRESS,
    wallet: currentWallet(view, agentId),
    creator,
    humanBacked: isHumanBacked(view, agentId),
    score: { value: result.score, tier: result.tier, isNew: result.isNew },
    creatorScore: creatorResult?.score ?? null,
    reviewsCounted: result.counted,
    registeredAt: registeredAt ? toIso(registeredAt) : toIso(view.asOf),
  };
}

/** Anyone can append a response on-chain, so only the agent's own owner or wallet is shown. */
function responseTo(view: LiveView, review: ClassifiedReview): ReviewResponse | undefined {
  const agent = agentInput(view.state, review.agentId);
  const key = feedbackKey(review.agentId, review.client, review.feedbackIndex);
  const fromAgent = (view.state.responses.get(key) ?? []).filter(
    ({ responder, timestamp }) =>
      responder === ownerAt(agent, timestamp) || responder === agentWalletAt(agent, timestamp),
  );
  const latest = fromAgent.at(-1);
  if (!latest) return undefined;
  const { responder, uri, hash, timestamp } = latest;
  return { responder, uri, hash, createdAt: toIso(timestamp) };
}

function toReview(view: LiveView, review: ClassifiedReview): Review {
  const response = responseTo(view, review);
  return {
    clientAddress: review.client,
    feedbackIndex: review.feedbackIndex,
    value: review.normalizedValue ?? Number(review.value) / 10 ** review.valueDecimals,
    tag1: review.tag1,
    tag2: review.tag2,
    endpoint: review.endpoint,
    ...(review.comment !== undefined ? { comment: review.comment } : {}),
    createdAt: toIso(review.timestamp),
    paymentVerified: review.paymentVerified,
    counted: review.counted,
    ...(review.exclusionReason ? { exclusionReason: review.exclusionReason } : {}),
    reviewerHumanBacked: review.reviewerHumanBacked,
    feedbackUri: review.feedbackUri,
    txId: review.txHash,
    ...(response ? { response } : {}),
  };
}

function credentialsOf(runtime: ScorerRuntime, view: LiveView, agentId: string): Credential[] {
  const link = view.state.links.get(agentId);
  const wallet = currentWallet(view, agentId) ?? link?.wallets.at(-1)?.wallet;
  const ownSerials = new Set(link?.wallets.map((vouched) => vouched.serial));
  const vouchSerials = new Set(
    [...view.state.links.values()].flatMap((item) => item.wallets.map(({ serial }) => serial)),
  );
  // A credential event can only come from the registry, so this is set whenever one exists.
  const issuer = (runtime.settings.creatorRegistry?.toLowerCase() ?? ZERO_ADDRESS) as Address;

  return view.state.credentials
    .filter(
      (credential) =>
        ownSerials.has(credential.serial) ||
        (credential.holder === wallet && !vouchSerials.has(credential.serial)),
    )
    .map((credential) => ({
      tokenId: runtime.settings.credentialTokenId ?? '',
      serial: credential.serial,
      title: ownSerials.has(credential.serial) ? 'Human-backed' : `Credential #${credential.serial}`,
      issuedAt: toIso(credential.issuedAt),
      revoked: credential.revokedAt !== null,
      issuer,
    }));
}

function agentDetail(runtime: ScorerRuntime, view: LiveView, result: AgentResult): AgentDetail {
  const { agentId } = result;
  const profile = profileOf(runtime, view, agentId);
  const compromisedAt = view.state.compromisedAt.get(agentId);
  const published = runtime.store.latestPublishedSnapshot();
  return {
    ...toSummary(runtime, view, result, profile),
    endpoints: profile.endpoints,
    agentUri: view.state.identities.get(agentId)?.agentUri ?? '',
    operatorChanged: operatorChanged(view, agentId),
    ...(compromisedAt ? { compromisedAt: toIso(compromisedAt) } : {}),
    credentials: credentialsOf(runtime, view, agentId),
    reviews: view.result.reviews
      .filter((review) => review.agentId === agentId)
      .map((review) => toReview(view, review))
      .reverse(),
    reviewsExcluded: result.excluded,
    penaltiesConfirmed: result.penaltiesConfirmed,
    updatedAt: toIso(view.asOf),
    ...(published ? { snapshotUrl: hashscan.topic(runtime.settings.scoresTopicId) } : {}),
  };
}

function matches(summary: AgentSummary, query: string): boolean {
  const needle = query.toLowerCase();
  return [summary.name, summary.description, ...summary.tags].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

function listAgents(
  runtime: ScorerRuntime,
  view: LiveView | null,
  query: z.output<typeof listQuery>,
): AgentListResponse {
  if (!view) {
    return { agents: [], stats: { agents: 0, humanBacked: 0, creators: 0, reviewsCounted: 0 } };
  }
  // Lookups are what add unlinked agents to the view, and a visit must not change this list.
  const all = view.result.agents
    .filter((result) => result.creator !== null)
    .map((result) => toSummary(runtime, view, result, profileOf(runtime, view, result.agentId)));
  const agents = all
    .filter((agent) => !query.q || matches(agent, query.q))
    .filter(
      (agent) => query.humanBacked === undefined || String(agent.humanBacked) === query.humanBacked,
    )
    .filter((agent) => query.minScore === undefined || agent.score.value >= query.minScore)
    .sort((a, b) => b.score.value - a.score.value);

  return {
    agents,
    stats: {
      agents: all.length,
      humanBacked: all.filter((agent) => agent.humanBacked).length,
      creators: view.result.creators.length,
      reviewsCounted: all.reduce((total, agent) => total + agent.reviewsCounted, 0),
    },
  };
}

function creatorDetail(runtime: ScorerRuntime, view: LiveView, address: Address): CreatorDetail {
  const creator = view.result.creators.find((item) => item.creator === address);
  const registered = view.state.creators.get(address);
  if (!creator || !registered) throw notFound('Creator');
  return {
    address,
    verifiedAt: toIso(registered.registeredAt),
    score: creator.score,
    tier: creator.tier,
    penaltyTotal: creator.P,
    penalties: creator.penalties.map(({ agentId, category, points, confirmedAt }) => ({
      agentId,
      category,
      points,
      confirmedAt: toIso(confirmedAt),
    })),
    agents: view.result.agents
      .filter((agent) => agent.creator === address)
      .map((result) => toSummary(runtime, view, result, profileOf(runtime, view, result.agentId))),
  };
}

export function registerReadRoutes(
  app: FastifyInstance,
  runtime: ScorerRuntime = getScorerRuntime(),
): void {
  app.get('/api/agents', async (req): Promise<AgentListResponse> => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join('.') || 'query';
      throw badRequest(`Invalid query: check "${field}".`);
    }
    return listAgents(runtime, runtime.view(), parsed.data);
  });

  app.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId',
    async (req): Promise<AgentDetail> => {
      const { agentId } = req.params;
      if (!/^\d{1,78}$/.test(agentId)) throw notFound('Agent');
      const id = BigInt(agentId).toString();

      try {
        if (!(await runtime.trackAgent(id))) throw notFound('Agent');
      } catch (err) {
        if (err instanceof ApiHttpError) throw err;
        req.log.error({ err: (err as Error).name }, 'agent lookup failed');
        throw chainError('Could not read this agent from the Mirror Node. Try again.');
      }

      const view = runtime.view();
      const result = view?.result.agents.find((agent) => agent.agentId === id);
      if (!view || !result) throw notFound('Agent');
      return agentDetail(runtime, view, result);
    },
  );

  app.get<{ Params: { address: string } }>(
    '/api/creators/:address',
    async (req): Promise<CreatorDetail> => {
      const address = req.params.address.toLowerCase();
      const view = runtime.view();
      if (!view || !/^0x[0-9a-f]{40}$/.test(address)) throw notFound('Creator');
      return creatorDetail(runtime, view, address as Address);
    },
  );
}
