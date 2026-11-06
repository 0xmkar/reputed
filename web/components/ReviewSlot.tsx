'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import type { AgentDetail } from '@reputed/shared';
import { ReviewModal } from './review/ReviewModal';

const POLL_MS = 2_000;
const SLOW_AFTER_MS = 30_000;
const STOP_AFTER_MS = 120_000;

function reviewsBy(agent: AgentDetail, client: string): number {
  return agent.reviews.filter((r) => r.clientAddress.toLowerCase() === client.toLowerCase()).length;
}

interface Waiting {
  client: string;
  /** How many reviews the API had from this wallet when the transaction was sent. */
  known: number;
  run: number;
}

/**
 * A confirmed review only reaches GET /api/agents/:id once the server has indexed it, so after
 * confirming this keeps refetching the agent until the review shows up.
 */
function useReviewArrival(agent: AgentDetail) {
  const queryClient = useQueryClient();
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [slow, setSlow] = useState(false);
  const arrived = waiting !== null && reviewsBy(agent, waiting.client) > waiting.known;
  const run = waiting?.run;

  useEffect(() => {
    if (run === undefined || arrived) return;
    const refetch = () => void queryClient.invalidateQueries({ queryKey: ['agent', agent.agentId] });
    refetch();
    const poll = setInterval(refetch, POLL_MS);
    const slowTimer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    const stopTimer = setTimeout(() => clearInterval(poll), STOP_AFTER_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(slowTimer);
      clearTimeout(stopTimer);
    };
  }, [run, arrived, agent.agentId, queryClient]);

  return {
    waiting: waiting !== null && !arrived,
    slow,
    watchFor: (client: string, known: number) => {
      setSlow(false);
      setWaiting({ client, known, run: Date.now() });
    },
    refresh: () => {
      setSlow(false);
      setWaiting((current) => current && { ...current, run: Date.now() });
    },
  };
}

/** The "Leave a review" entry point on the Agent page. Stays mounted so a review in progress survives closing. */
export function ReviewSlot({ agent }: { agent: AgentDetail }) {
  const { address } = useAccount();
  const [open, setOpen] = useState(false);
  // The form mounts on first open, and starts empty again after a confirmed review.
  const [form, setForm] = useState({ mounted: false, key: 0, confirmed: false });
  const arrival = useReviewArrival(agent);
  const isOwner = address !== undefined && address.toLowerCase() === agent.owner.toLowerCase();

  function onConfirmed(reviewsBefore: number) {
    setForm((f) => ({ ...f, confirmed: true }));
    if (address) arrival.watchFor(address, reviewsBefore);
  }

  function onClose() {
    setOpen(false);
    setForm((f) => (f.confirmed ? { mounted: false, key: f.key + 1, confirmed: false } : f));
  }

  return (
    <div className="review-slot">
      <button
        type="button"
        className="btn btn-primary"
        disabled={isOwner}
        title={isOwner ? 'You can’t review your own agent.' : undefined}
        onClick={() => {
          setForm((f) => ({ ...f, mounted: true }));
          setOpen(true);
        }}
      >
        Leave a review
      </button>
      {isOwner && <span className="muted review-slot-note">You can’t review your own agent.</span>}
      {arrival.waiting && (
        <span className="muted review-slot-note" role="status">
          {arrival.slow ? 'Taking longer than usual to index your review.' : 'Your review is confirmed. Adding it to the list…'}{' '}
          {arrival.slow && (
            <button type="button" className="btn btn-outline btn-small" onClick={arrival.refresh}>
              Refresh
            </button>
          )}
        </span>
      )}
      {form.mounted && <ReviewModal key={form.key} agent={agent} client={address} open={open} onClose={onClose} onConfirmed={onConfirmed} />}
    </div>
  );
}
