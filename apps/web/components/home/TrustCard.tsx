'use client';

import Link from 'next/link';
import type { AgentSummary } from '@reputed/shared';
import { useAgents } from '@/lib/useAgents';
import { HumanBackedBadge } from '../HumanBackedBadge';
import { TierBadge } from '../TierBadge';
import { ShieldIcon } from '../icons';

const SHOWN = 2;

function TrustRow({ agent }: { agent: AgentSummary }) {
  return (
    <Link href={`/agent/${agent.agentId}`} className="trust-row">
      <span className="trust-row-title">
        <span className="trust-row-name">{agent.name}</span>
        <span className="mono">#{agent.agentId}</span>
      </span>
      <span className="trust-row-score">
        {agent.reviewsCounted} {agent.reviewsCounted === 1 ? 'review' : 'reviews'}
      </span>
      <span className="trust-row-meta">
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <TierBadge tier={agent.score.tier} isNew={agent.score.isNew} />
          {agent.humanBacked && <HumanBackedBadge />}
        </span>
        <span className="trust-row-big">
          <b>{Math.round(agent.score.value)}</b>
          <span>/ 100</span>
        </span>
      </span>
    </Link>
  );
}

function TrustRowSkeleton() {
  return (
    <div className="trust-row" aria-hidden="true">
      <span className="skeleton skeleton-text" style={{ width: '9em' }} />
      <span className="skeleton skeleton-text" style={{ width: '5em' }} />
      <span className="trust-row-meta">
        <span className="skeleton skeleton-text" style={{ width: '7em' }} />
        <span className="skeleton skeleton-text" style={{ width: '3em', height: '1.6em' }} />
      </span>
    </div>
  );
}

/** The floating card in the hero: the two highest-scored human-backed agents, live from the API. */
export function TrustCard() {
  const { data, isLoading, error, refetch } = useAgents({ humanBacked: true });
  const top = data?.agents.toSorted((a, b) => b.score.value - a.score.value).slice(0, SHOWN);

  let body;
  if (error && !top) {
    body = (
      <p className="trust-note">
        Couldn&apos;t reach the Reputed API.{' '}
        <button type="button" onClick={() => void refetch()}>
          Retry
        </button>
      </p>
    );
  } else if (isLoading || !top) {
    body = [0, 1].map((i) => <TrustRowSkeleton key={i} />);
  } else if (top.length === 0) {
    body = (
      <p className="trust-note">
        No human-backed agents yet. <Link href="/dashboard">Add the first one</Link>.
      </p>
    );
  } else {
    body = top.map((a) => <TrustRow key={a.agentId} agent={a} />);
  }

  return (
    <aside className="glass trust-card" aria-label="Top human-backed agents">
      <span className="trust-card-handle" aria-hidden="true" />
      <div className="trust-card-head">
        <span>
          <ShieldIcon /> Top human-backed agents
        </span>
        <span>Hedera Testnet</span>
      </div>
      {body}
      <div className="trust-card-foot">
        <span className="chip-coral">One human, one creator</span>
        <Link href="/explore">See all</Link>
      </div>
    </aside>
  );
}
