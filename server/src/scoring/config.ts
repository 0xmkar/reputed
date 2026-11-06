export interface ScoringConfig {
  configVersion: number;
  reviewHalfLifeDays: number;
  penaltyHalfLifeDays: number;
  reviewerWeightFloor: number;
  penalties: Record<string, number>;
  misconduct: { distinctCreators: number; windowDays: number; reporterCooldownDays: number };
  tierCutoffs: { tier1: number; tier2: number };
  /** An epoch number means nothing without this, so snapshots carry it. See Store.SnapshotSeries. */
  epochSeconds: number;
  /** Reviewer weights are circular, so scoring stops here even if rounding keeps it oscillating. */
  fixedPointIterations: number;
}

/** Bump configVersion whenever a value here changes: it is published with every snapshot. */
export const SCORING_CONFIG: ScoringConfig = Object.freeze({
  configVersion: 2,
  reviewHalfLifeDays: 90,
  penaltyHalfLifeDays: 180,
  reviewerWeightFloor: 0.2,
  penalties: Object.freeze({ fraud: 20, 'failed-settlement': 10 }),
  misconduct: Object.freeze({ distinctCreators: 2, windowDays: 30, reporterCooldownDays: 180 }),
  tierCutoffs: Object.freeze({ tier1: 90, tier2: 75 }),
  epochSeconds: 3600,
  fixedPointIterations: 32,
});
