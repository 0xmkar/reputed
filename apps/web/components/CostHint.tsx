interface Props {
  /** Estimated network fee in US dollars, from the caller's fixed fee table. */
  usd: number;
}

export function CostHint({ usd }: Props) {
  return <span className="cost-hint muted">≈ ${usd.toFixed(2)} network fee</span>;
}
