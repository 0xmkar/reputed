import type { Tier } from '@reputed/shared';

interface Props {
  tier: Tier;
  /** True when the score is inherited from the creator: shows "New" instead of the tier. */
  isNew?: boolean;
}

const TIER_CLASS: Record<Tier, string> = {
  'Tier 1': 'tier-1',
  'Tier 2': 'tier-2',
  'Tier 3': 'tier-3',
};

export function TierBadge({ tier, isNew = false }: Props) {
  return <span className={`badge tier-badge ${isNew ? 'tier-new' : TIER_CLASS[tier]}`}>{isNew ? 'New' : tier}</span>;
}
