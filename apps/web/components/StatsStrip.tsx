import type { AgentListResponse } from '@reputed/shared';

type Stats = AgentListResponse['stats'];

const ITEMS: { key: keyof Stats; label: string }[] = [
  { key: 'agents', label: 'Agents' },
  { key: 'humanBacked', label: 'Human-backed' },
  { key: 'creators', label: 'Creators' },
  { key: 'reviewsCounted', label: 'Reviews counted' },
];

/** Pass undefined while loading to show skeleton blocks. */
export function StatsStrip({ stats }: { stats: Stats | undefined }) {
  return (
    <dl className="stats">
      {ITEMS.map(({ key, label }) => (
        <div key={key} className="stat">
          <dt className="muted">{label}</dt>
          <dd>{stats ? stats[key].toLocaleString('en-US') : <span className="skeleton skeleton-text" />}</dd>
        </div>
      ))}
    </dl>
  );
}
