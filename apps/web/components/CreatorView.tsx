'use client';

import Link from 'next/link';
import { useAccount } from 'wagmi';
import { hashscan, type Address, type AgentSummary, type CreatorDetail } from '@reputed/shared';
import { daysUntil, formatDate } from '@/lib/format';
import { useCreator } from '@/lib/useCreator';
import { AddressChip } from './AddressChip';
import { ReportCompromised } from './creator/ReportCompromised';
import { EmptyState } from './EmptyState';
import { InlineError } from './InlineError';
import { ScoreRing } from './ScoreRing';
import { TierBadge } from './TierBadge';
import { VerifiedCreatorBadge } from './VerifiedCreatorBadge';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Points shown with at most one decimal: 20 -> "20", 12.5 -> "12.5". */
function points(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function AgentStatus({ agent }: { agent: AgentSummary }) {
  switch (agent.status) {
    case 'active':
      return <span className="badge badge-verified">Active</span>;
    case 'compromised':
      return <span className="badge badge-danger">Compromised</span>;
    case 'operator-changed':
      return <span className="badge tier-3">Operator changed</span>;
  }
}

function AgentsTable({ agents, isOwner }: { agents: AgentSummary[]; isOwner: boolean }) {
  if (agents.length === 0) return <EmptyState message="This creator has no agents yet." />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Agent ID</th>
            <th>Score</th>
            <th>Tier</th>
            <th>Reviews counted</th>
            <th>Status</th>
            <th>
              <span className="sr-only">View</span>
            </th>
            {isOwner && (
              <th>
                <span className="sr-only">Owner actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.agentId}>
              <td>{a.name}</td>
              <td className="mono">#{a.agentId}</td>
              <td>
                <ScoreRing value={a.score.value} tier={a.score.tier} isNew={a.score.isNew} />
              </td>
              <td>
                <TierBadge tier={a.score.tier} isNew={a.score.isNew} />
              </td>
              <td>{a.reviewsCounted}</td>
              <td>
                <AgentStatus agent={a} />
              </td>
              <td>
                <Link href={`/agent/${a.agentId}`}>View</Link>
              </td>
              {isOwner && (
                <td>
                  <ReportCompromised agent={a} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function halvingText(iso: string): string {
  const days = daysUntil(iso);
  if (days === null) return '';
  return days === 0 ? 'halving today' : `halving in ${days} ${days === 1 ? 'day' : 'days'}`;
}

function Penalties({ creator }: { creator: CreatorDetail }) {
  if (creator.penalties.length === 0) {
    return <p className="muted">No confirmed penalties.</p>;
  }
  // The summary counts down to the soonest halving among penalties that still carry points.
  const next = creator.penalties
    .filter((p) => p.points > 0)
    .map((p) => p.nextHalvingAt)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return (
    <>
      <p>
        <strong>−{points(creator.penaltyTotal)} points</strong>
        {next && <>, {halvingText(next)}</>}
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Agent</th>
              <th>Category</th>
              <th>Current points</th>
              <th>Next halving</th>
              <th>Reports</th>
            </tr>
          </thead>
          <tbody>
            {creator.penalties.map((p) => (
              <tr key={`${p.agentId}-${p.category}-${p.confirmedAt}`}>
                <td>{formatDate(p.confirmedAt)}</td>
                <td>
                  <Link href={`/agent/${p.agentId}`} className="mono">
                    #{p.agentId}
                  </Link>
                </td>
                <td>{p.category}</td>
                <td>−{points(p.points)}</td>
                <td>{formatDate(p.nextHalvingAt)}</td>
                <td>
                  {p.reports.length === 0 ? (
                    <span className="muted">None</span>
                  ) : (
                    <span className="row">
                      {p.reports.map((r, i) => (
                        <a key={`${r.clientAddress}-${r.feedbackIndex}`} href={hashscan.tx(r.txId)} target="_blank" rel="noreferrer">
                          Report {i + 1}
                        </a>
                      ))}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CreatorSkeleton() {
  return (
    <div className="agent-hero" aria-hidden="true">
      <span className="skeleton skeleton-ring skeleton-ring-lg" />
      <div className="agent-hero-text">
        <span className="skeleton skeleton-text" style={{ width: '14em', height: '1.6em' }} />
        <span className="skeleton skeleton-text" style={{ width: '10em' }} />
      </div>
    </div>
  );
}

export function CreatorView({ address }: { address: string }) {
  const valid = ADDRESS.test(address);
  const { data: creator, isLoading, error, refetch } = useCreator(valid ? (address as Address) : undefined);
  const { address: connected } = useAccount();

  if (!valid) return <EmptyState message="That isn’t a valid wallet address." action={{ label: 'Explore agents', href: '/explore' }} />;
  // Keep showing the creator if only a background refresh failed.
  if (error && !creator) return <InlineError message="Couldn’t load this creator. The server may be down." onRetry={() => void refetch()} />;
  if (creator === null) {
    return (
      <EmptyState
        message="This wallet isn’t a verified creator."
        action={{ label: 'Verify with World ID', href: '/verify' }}
      />
    );
  }
  if (isLoading || !creator) return <CreatorSkeleton />;

  const isOwner = connected?.toLowerCase() === creator.address.toLowerCase();

  return (
    <article className="agent-page">
      <header className="agent-hero">
        <div className="agent-score">
          <ScoreRing value={creator.score} tier={creator.tier} size="lg" />
          <TierBadge tier={creator.tier} />
        </div>
        <div className="agent-hero-text">
          <h1>Creator</h1>
          <div className="row">
            <AddressChip address={creator.address} />
            <VerifiedCreatorBadge />
          </div>
          <p className="muted">Creator since {formatDate(creator.verifiedAt)}</p>
          <p className="muted" id="creator-score-info">
            Creator score: average of your agents, capped at 100 minus penalties.
          </p>
        </div>
        {isOwner && (
          <Link href="/dashboard" className="btn btn-primary">
            Add agent
          </Link>
        )}
      </header>

      <section className="card">
        <h2>Penalties</h2>
        <Penalties creator={creator} />
      </section>

      <section>
        <h2>Agents</h2>
        <AgentsTable agents={creator.agents} isOwner={isOwner} />
      </section>
    </article>
  );
}
