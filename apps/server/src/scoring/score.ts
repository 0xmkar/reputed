// The scoring formulas from docs/02-implementation-plan.md, Phase 5:
//   w_i = max(0.2, C_reviewer / 100) * 0.5^(age_i / 90d) / n_i     A = min(avg_w(v), 100 - P_agent)
//   C   = min(mean of reviewed agents' A weighted by distinct reviewers, 100 - P)
//   P   = sum of confirmed penalties, each decayed 0.5^(age / 180d) from its confirmation
// Published values are rounded to two decimals, and the fixed-point loop runs on rounded values.
import type { Address, Tier } from '@reputed/shared';
import type { ScoringConfig } from './config.ts';
import { classifyReviews, compareReviews } from './filter.ts';
import { confirmMisconduct, decay, round2, sumPoints } from './misconduct.ts';
import { ageInDays, type ConsensusTimestamp } from './time.ts';
import type {
  AgentInput,
  AgentResult,
  ClassifiedReview,
  ConfirmedPenalty,
  CreatorInput,
  CreatorResult,
  ScoreResult,
  ScoringInputs,
} from './types.ts';

export function tierFor(score: number, config: ScoringConfig): Tier {
  if (score >= config.tierCutoffs.tier1) return 'Tier 1';
  if (score >= config.tierCutoffs.tier2) return 'Tier 2';
  return 'Tier 3';
}

/**
 * The plan's weighted average with one addition: a review's weight is divided by how many counted
 * reviews its creator left on this agent. A creator therefore has one vote however many reviews
 * it sends, and with one review per creator this is exactly the plan's formula.
 */
export function weightedAverage(
  counted: ClassifiedReview[],
  creatorScores: ReadonlyMap<Address, number>,
  config: ScoringConfig,
  now: ConsensusTimestamp,
): number | null {
  const perCreator = new Map<Address, number>();
  for (const review of counted) {
    const creator = review.reviewerCreator as Address;
    perCreator.set(creator, (perCreator.get(creator) ?? 0) + 1);
  }

  let weightSum = 0;
  let valueSum = 0;
  for (const review of [...counted].sort(compareReviews)) {
    const creator = review.reviewerCreator as Address;
    const reviewerWeight = Math.max(
      config.reviewerWeightFloor,
      (creatorScores.get(creator) ?? 0) / 100,
    );
    const weight =
      (reviewerWeight * decay(ageInDays(review.timestamp, now), config.reviewHalfLifeDays)) /
      perCreator.get(creator)!;
    weightSum += weight;
    valueSum += weight * review.normalizedValue!;
  }
  return weightSum > 0 ? valueSum / weightSum : null;
}

/**
 * Value-0 fraud reports already pull the average down as ordinary counted reviews. The penalty is
 * a cap on top, not a second subtraction: A = min(average, 100 - P_agent). Good reviews can then
 * never lift a penalised agent past the penalty, the same way the creator cap stops dilution.
 */
export function agentScore(average: number, agentPenalties: ConfirmedPenalty[]): number {
  return round2(Math.max(0, Math.min(average, 100 - sumPoints(agentPenalties))));
}

export function creatorCap(creatorPenalties: ConfirmedPenalty[]): number {
  return round2(Math.max(0, 100 - sumPoints(creatorPenalties)));
}

/** A creator with no reviewed agents has no average, so only the cap applies. */
export function creatorScore(
  reviewed: { score: number; weight: number }[],
  creatorPenalties: ConfirmedPenalty[],
): number {
  const cap = creatorCap(creatorPenalties);
  const totalWeight = reviewed.reduce((total, agent) => total + agent.weight, 0);
  if (totalWeight === 0) return cap;
  const average =
    reviewed.reduce((total, agent) => total + agent.score * agent.weight, 0) / totalWeight;
  return round2(Math.min(average, cap));
}

function groupBy<K, V>(items: V[], keyOf: (item: V) => K | null): Map<K, V[]> {
  const groups = new Map<K, V[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function sameScores(a: ReadonlyMap<Address, number>, b: ReadonlyMap<Address, number>): boolean {
  for (const [creator, score] of a) if (b.get(creator) !== score) return false;
  return true;
}

/**
 * Reviewer weights need creator scores and creator scores need agent scores. Everything else
 * (filter, penalties) does not depend on a score, so only this loop iterates. It starts every
 * creator at 100 - P and runs a fixed number of rounds on rounded values. No previous snapshot
 * is read, so a rebuild from public data needs no history. Creators are derived once more from the
 * final agent scores, so a published creator score always matches the published agent scores, even
 * if the loop hit its limit before settling.
 */
export function computeScores(
  inputs: ScoringInputs,
  config: ScoringConfig,
  now: ConsensusTimestamp,
): ScoreResult {
  const reviews = classifyReviews(inputs);
  const penalties = confirmMisconduct(reviews, inputs.agents, config, now);

  const countedByAgent = groupBy(
    reviews.filter((review) => review.counted),
    (review) => review.agentId,
  );
  const penaltiesByAgent = groupBy(penalties, (penalty) => penalty.agentId);
  const creatorPenalties = groupBy(
    penalties.filter((penalty) => penalty.countsAgainstCreator),
    (penalty) => penalty.creator,
  );

  const creators = creatorList(inputs.creators, inputs.agents);
  const agentsByCreator = groupBy(inputs.agents, (agent) => agent.creator);
  const distinctReviewers = (agentId: string) =>
    new Set((countedByAgent.get(agentId) ?? []).map((review) => review.reviewerCreator)).size;

  const scoreAgents = (creatorScores: ReadonlyMap<Address, number>) => {
    const scores = new Map<string, number>();
    for (const [agentId, counted] of countedByAgent) {
      const average = weightedAverage(counted, creatorScores, config, now);
      if (average !== null) scores.set(agentId, agentScore(average, penaltiesByAgent.get(agentId) ?? []));
    }
    return scores;
  };

  const scoreCreators = (agentScores: ReadonlyMap<string, number>) => {
    const scores = new Map<Address, number>();
    for (const creator of creators) {
      const reviewed = (agentsByCreator.get(creator) ?? []).flatMap((agent) => {
        const score = agentScores.get(agent.agentId);
        return score === undefined ? [] : [{ score, weight: distinctReviewers(agent.agentId) }];
      });
      scores.set(creator, creatorScore(reviewed, creatorPenalties.get(creator) ?? []));
    }
    return scores;
  };

  let creatorScores = new Map<Address, number>(
    creators.map((creator) => [creator, creatorCap(creatorPenalties.get(creator) ?? [])]),
  );
  let iterations = 0;
  while (iterations < config.fixedPointIterations) {
    iterations += 1;
    const next = scoreCreators(scoreAgents(creatorScores));
    const settled = sameScores(creatorScores, next);
    creatorScores = next;
    if (settled) break;
  }
  const agentScores = scoreAgents(creatorScores);
  creatorScores = scoreCreators(agentScores);

  const excludedByAgent = groupBy(
    reviews.filter((review) => !review.counted),
    (review) => review.agentId,
  );

  const agents: AgentResult[] = [...inputs.agents]
    .sort((a, b) => compareIds(a.agentId, b.agentId))
    .map((agent) => {
      const counted = countedByAgent.get(agent.agentId)?.length ?? 0;
      const measured = agentScores.get(agent.agentId);
      // An unlinked agent with no reviews has no creator to inherit from, so it starts at 0.
      const score =
        measured ?? (agent.creator ? (creatorScores.get(agent.creator) ?? 0) : 0);
      return {
        agentId: agent.agentId,
        creator: agent.creator,
        score,
        tier: tierFor(score, config),
        isNew: measured === undefined && agent.creator !== null,
        counted,
        excluded: excludedByAgent.get(agent.agentId)?.length ?? 0,
        distinctReviewers: distinctReviewers(agent.agentId),
        penaltiesConfirmed: penaltiesByAgent.get(agent.agentId)?.length ?? 0,
      };
    });

  const creatorResults: CreatorResult[] = creators.map((creator) => {
    const own = creatorPenalties.get(creator) ?? [];
    const score = creatorScores.get(creator) ?? 0;
    return {
      creator,
      score,
      tier: tierFor(score, config),
      P: sumPoints(own),
      penalties: own,
    };
  });

  return {
    asOf: now,
    configVersion: config.configVersion,
    epochSeconds: config.epochSeconds,
    agents,
    creators: creatorResults,
    reviews,
    penalties,
    iterations,
  };
}

function creatorList(creators: CreatorInput[], agents: AgentInput[]): Address[] {
  const all = new Set<Address>(creators.map((creator) => creator.wallet));
  for (const agent of agents) if (agent.creator) all.add(agent.creator);
  return [...all].sort();
}

export function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
