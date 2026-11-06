import type { ReactNode } from 'react';
import type { AgentSummary } from '@reputed/shared';
import { AgentCard, AgentCardSkeleton } from './AgentCard';
import { InlineError } from './InlineError';

interface Props {
  agents: AgentSummary[] | undefined;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  /** Shown when the request succeeded but there is nothing to list. */
  empty: ReactNode;
}

/** The loading, error and empty states shared by Home and Explorer, then the grid. */
export function AgentGrid({ agents, isLoading, error, onRetry, empty }: Props) {
  if (error && !agents) {
    return <InlineError message="Couldn’t load agents. The server may be down." onRetry={onRetry} />;
  }
  if (isLoading || !agents) {
    return (
      <div className="agent-grid">
        {[0, 1, 2].map((i) => (
          <AgentCardSkeleton key={i} />
        ))}
      </div>
    );
  }
  if (agents.length === 0) return <>{empty}</>;
  return (
    <div className="agent-grid">
      {agents.map((a) => (
        <AgentCard key={a.agentId} agent={a} />
      ))}
    </div>
  );
}
