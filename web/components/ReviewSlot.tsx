'use client';

import { useAccount } from 'wagmi';
import type { AgentDetail } from '@reputed/shared';

/**
 * The "Leave a review" entry point on the Agent page. The review modal itself belongs to
 * Atharva (docs/05-work-split.md): replace the body of this component with the button that
 * opens it. Until then the button is disabled, and says why.
 */
export function ReviewSlot({ agent }: { agent: AgentDetail }) {
  const { address } = useAccount();
  const isOwner = Boolean(address && address.toLowerCase() === agent.owner.toLowerCase());
  const reason = isOwner ? 'You can’t review your own agent.' : 'The review form isn’t available yet.';
  return (
    <button type="button" className="btn btn-primary" disabled title={reason}>
      Leave a review
    </button>
  );
}
