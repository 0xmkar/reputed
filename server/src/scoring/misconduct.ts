import type { Address } from '@reputed/shared';
import type { ScoringConfig } from './config.ts';
import { normalizeTag } from './filter.ts';
import {
  addDays,
  ageInDays,
  compareConsensus,
  SECONDS_PER_DAY,
  toNanos,
  type ConsensusTimestamp,
} from './time.ts';
import type { AgentInput, ClassifiedReview, ConfirmedPenalty } from './types.ts';

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Rounded so a last-bit difference in Math.pow between engines cannot reach a published score. */
export function decay(ageDays: number, halfLifeDays: number): number {
  return Math.round(0.5 ** (ageDays / halfLifeDays) * 1e12) / 1e12;
}

export function decayedPoints(
  basePoints: number,
  confirmedAt: ConsensusTimestamp,
  now: ConsensusTimestamp,
  config: ScoringConfig,
): number {
  return round2(basePoints * decay(ageInDays(confirmedAt, now), config.penaltyHalfLifeDays));
}

/** The first whole half-life after confirmedAt that is strictly later than now. */
export function nextHalvingAt(
  confirmedAt: ConsensusTimestamp,
  now: ConsensusTimestamp,
  config: ScoringConfig,
): ConsensusTimestamp {
  const halfLife = BigInt(Math.round(config.penaltyHalfLifeDays * SECONDS_PER_DAY)) * 1_000_000_000n;
  const elapsed = toNanos(now) - toNanos(confirmedAt);
  const halvings = elapsed < 0n ? 1n : elapsed / halfLife + 1n;
  return addDays(confirmedAt, Number(halvings) * config.penaltyHalfLifeDays);
}

/**
 * The compromise cut-off. A penalty is dated by its first report, not its confirmation, so a
 * creator cannot wait for the first report and call reportCompromise before the second lands.
 */
export function countsAgainstCreator(
  firstReportAt: ConsensusTimestamp,
  compromisedAt: ConsensusTimestamp | null,
): boolean {
  return compromisedAt === null || compareConsensus(firstReportAt, compromisedAt) <= 0;
}

/**
 * Per agent and category, walks misconduct reports in consensus order. A penalty confirms the
 * moment the open reports inside the window come from enough distinct creators.
 *
 * One incident is one penalty: reports in the window after a confirmation are about that incident
 * and add nothing, however many creators send them. A creator who helped confirm a penalty also
 * sits out for the reporter cooldown, so a colluding pair cannot grind a target down.
 *
 * A confirmation is final. A report revoked before it never helped, but revoking afterwards does
 * not undo the penalty, since a creator who could buy a revocation could otherwise reset it.
 */
export function confirmMisconduct(
  reviews: ClassifiedReview[],
  agents: AgentInput[],
  config: ScoringConfig,
  now: ConsensusTimestamp,
): ConfirmedPenalty[] {
  const agentById = new Map(agents.map((agent) => [agent.agentId, agent]));
  const reportsByCase = new Map<string, ClassifiedReview[]>();

  for (const review of reviews) {
    if (!review.eligible || normalizeTag(review.tag1) !== 'misconduct') continue;
    const category = normalizeTag(review.tag2);
    // tag2 is chosen by the reviewer, and penalties has a prototype: 'constructor' is not a category.
    if (!Object.hasOwn(config.penalties, category)) continue;
    const key = `${review.agentId}|${category}`;
    const reports = reportsByCase.get(key);
    if (reports) reports.push(review);
    else reportsByCase.set(key, [review]);
  }

  const penalties: ConfirmedPenalty[] = [];
  for (const [key, reports] of reportsByCase) {
    const separator = key.indexOf('|');
    const agentId = key.slice(0, separator);
    const category = key.slice(separator + 1);
    const agent = agentById.get(agentId);
    let open: ClassifiedReview[] = [];
    let incidentEnds: ConsensusTimestamp | null = null;
    const cooldownEnds = new Map<Address, ConsensusTimestamp>();

    for (const report of reports) {
      const at = report.timestamp;
      const reporterCooldown = cooldownEnds.get(report.reviewerCreator as Address);
      if (incidentEnds !== null && compareConsensus(at, incidentEnds) <= 0) continue;
      if (reporterCooldown !== undefined && compareConsensus(at, reporterCooldown) <= 0) continue;

      open = open.filter(
        (earlier) =>
          compareConsensus(addDays(earlier.timestamp, config.misconduct.windowDays), at) >= 0 &&
          (earlier.revokedAt === null || compareConsensus(earlier.revokedAt, at) > 0),
      );
      open.push(report);

      const reporters = [...new Set(open.map((item) => item.reviewerCreator as Address))];
      if (reporters.length < config.misconduct.distinctCreators) continue;

      const basePoints = config.penalties[category]!;
      const firstReportAt = open[0]!.timestamp;
      penalties.push({
        agentId,
        creator: agent?.creator ?? null,
        category,
        basePoints,
        firstReportAt,
        confirmedAt: at,
        reporters: reporters.sort(),
        reports: open.map(({ client, feedbackIndex, txHash, timestamp }) => ({
          client,
          feedbackIndex,
          txHash,
          timestamp,
        })),
        countsAgainstCreator: countsAgainstCreator(firstReportAt, agent?.compromisedAt ?? null),
        points: decayedPoints(basePoints, at, now, config),
      });
      open = [];
      incidentEnds = addDays(at, config.misconduct.windowDays);
      for (const reporter of reporters) {
        cooldownEnds.set(reporter, addDays(at, config.misconduct.reporterCooldownDays));
      }
    }
  }

  return penalties.sort(
    (a, b) => compareConsensus(a.confirmedAt, b.confirmedAt) || a.agentId.localeCompare(b.agentId),
  );
}

export function sumPoints(penalties: ConfirmedPenalty[]): number {
  return round2(penalties.reduce((total, penalty) => total + penalty.points, 0));
}
