'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AgentSummary, Tier } from '@reputed/shared';
import { useAgents } from '@/lib/useAgents';
import { AgentGrid } from '@/components/AgentGrid';
import { EmptyState } from '@/components/EmptyState';
import { StatsStrip } from '@/components/StatsStrip';

type Sort = 'score' | 'reviews' | 'newest';

const SORTS: Record<Sort, { label: string; compare: (a: AgentSummary, b: AgentSummary) => number }> = {
  score: { label: 'Score', compare: (a, b) => b.score.value - a.score.value },
  reviews: { label: 'Most reviewed', compare: (a, b) => b.reviewsCounted - a.reviewsCounted },
  newest: { label: 'Newest', compare: (a, b) => Date.parse(b.registeredAt) - Date.parse(a.registeredAt) },
};

const TIERS: Tier[] = ['Tier 1', 'Tier 2', 'Tier 3'];

export default function ExplorePage() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [humanBacked, setHumanBacked] = useState(true);
  const [minScore, setMinScore] = useState(0);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [sort, setSort] = useState<Sort>('score');

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, error, refetch } = useAgents({ q: q || undefined, humanBacked, minScore });

  const agents = useMemo(() => {
    if (!data) return undefined;
    return data.agents
      .filter((a) => tiers.length === 0 || tiers.includes(a.score.tier))
      .toSorted(SORTS[sort].compare);
  }, [data, tiers, sort]);

  function reset() {
    setSearch('');
    setQ('');
    setHumanBacked(true);
    setMinScore(0);
    setTiers([]);
  }

  return (
    <section>
      <h1>Explore agents</h1>
      <StatsStrip stats={data?.stats} />

      <div className="filters">
        <input
          type="search"
          className="input"
          placeholder="Search by name, description or tag"
          aria-label="Search agents"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={humanBacked} onChange={(e) => setHumanBacked(e.target.checked)} />
          Human-backed only
        </label>
        <label className="slider">
          <span>Minimum score: {minScore}</span>
          <input type="range" min={0} max={100} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} />
        </label>
        <div className="chips" role="group" aria-label="Tier">
          {TIERS.map((t) => (
            <button
              key={t}
              type="button"
              className={`chip chip-toggle${tiers.includes(t) ? ' is-on' : ''}`}
              aria-pressed={tiers.includes(t)}
              onClick={() => setTiers((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))}
            >
              {t}
            </button>
          ))}
        </div>
        <label className="sort">
          <span className="muted">Sort</span>
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {Object.entries(SORTS).map(([key, { label }]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <AgentGrid
        agents={agents}
        isLoading={isLoading}
        error={error}
        onRetry={() => void refetch()}
        empty={<EmptyState message="No agents match. Try a lower minimum score." action={{ label: 'Reset filters', onClick: reset }} />}
      />
    </section>
  );
}
