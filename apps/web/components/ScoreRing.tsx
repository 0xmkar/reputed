import type { Tier } from '@reputed/shared';

interface Props {
  /** 0-100 */
  value: number;
  tier: Tier;
  isNew?: boolean;
  size?: 'sm' | 'lg';
}

const TIER_CLASS: Record<Tier, string> = {
  'Tier 1': 'tier-1',
  'Tier 2': 'tier-2',
  'Tier 3': 'tier-3',
};

const RADIUS = 44;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ScoreRing({ value, tier, isNew = false, size = 'sm' }: Props) {
  const clamped = Math.min(100, Math.max(0, value));
  const rounded = Math.round(clamped);
  const label = `Score ${rounded} out of 100, ${isNew ? 'new' : tier}`;
  return (
    <div className={`score-ring score-ring-${size} ${isNew ? 'tier-new' : TIER_CLASS[tier]}`} role="img" aria-label={label}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="ring-track" cx="50" cy="50" r={RADIUS} />
        <circle
          className="ring-value"
          cx="50"
          cy="50"
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - clamped / 100)}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <span className="ring-number">{rounded}</span>
    </div>
  );
}
