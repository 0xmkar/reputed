import Link from 'next/link';
import type { AgentSummary } from '@reputed/shared';
import { HumanBackedBadge } from './HumanBackedBadge';
import { ScoreRing } from './ScoreRing';
import { TierBadge } from './TierBadge';

function isWebUrl(url: string | undefined): url is string {
  return Boolean(url && (url.startsWith('https://') || url.startsWith('http://')));
}

export function AgentCard({ agent }: { agent: AgentSummary }) {
  return (
    <Link href={`/agent/${agent.agentId}`} className="card agent-card">
      <div className="agent-card-head">
        {isWebUrl(agent.image) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="agent-image" src={agent.image} alt="" width={48} height={48} loading="lazy" />
        ) : (
          <span className="agent-image agent-image-fallback" aria-hidden="true">
            {agent.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="agent-card-title">
          <h3>{agent.name}</h3>
          <span className="muted mono">#{agent.agentId}</span>
        </div>
        <ScoreRing value={agent.score.value} tier={agent.score.tier} isNew={agent.score.isNew} />
      </div>
      <div className="agent-badges">
        <TierBadge tier={agent.score.tier} isNew={agent.score.isNew} />
        {agent.humanBacked && <HumanBackedBadge />}
      </div>
      <p className="agent-desc">{agent.description}</p>
      <div className="agent-card-foot muted">
        <span>{agent.creatorScore === null ? 'No creator score' : `Creator score ${Math.round(agent.creatorScore)}`}</span>
        <span>
          {agent.reviewsCounted} {agent.reviewsCounted === 1 ? 'review' : 'reviews'}
        </span>
      </div>
    </Link>
  );
}

export function AgentCardSkeleton() {
  return (
    <div className="card agent-card" aria-hidden="true">
      <div className="agent-card-head">
        <span className="skeleton agent-image" />
        <div className="agent-card-title">
          <span className="skeleton skeleton-text" style={{ width: '8em' }} />
        </div>
        <span className="skeleton skeleton-ring" />
      </div>
      <span className="skeleton skeleton-text" style={{ width: '5em' }} />
      <span className="skeleton skeleton-text" />
      <span className="skeleton skeleton-text" style={{ width: '60%' }} />
    </div>
  );
}
