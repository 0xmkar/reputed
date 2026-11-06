'use client';

import Link from 'next/link';
import { useAgents } from '@/lib/useAgents';
import { AgentGrid } from './AgentGrid';
import { EmptyState } from './EmptyState';
import { StatsStrip } from './StatsStrip';

const FEATURED_COUNT = 9;

export function HomeAgents() {
  const { data, isLoading, error, refetch } = useAgents({ humanBacked: true });
  const top = data?.agents.toSorted((a, b) => b.score.value - a.score.value).slice(0, FEATURED_COUNT);

  return (
    <>
      <StatsStrip stats={data?.stats} />
      <div className="section-head">
        <h2>Human-backed agents</h2>
        <Link href="/explore">Explore all</Link>
      </div>
      <AgentGrid
        agents={top}
        isLoading={isLoading}
        error={error}
        onRetry={() => void refetch()}
        empty={<EmptyState message="No human-backed agents yet. Be the first to onboard one." action={{ label: 'Onboard agent', href: '/onboard' }} />}
      />
    </>
  );
}
