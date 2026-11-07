'use client';

import { useMemo, useState } from 'react';
import type { Review } from '@reputed/shared';
import { EmptyState } from './EmptyState';
import { ReviewCard } from './ReviewCard';

type Tab = 'all' | 'counted' | 'excluded' | 'misconduct';

const TABS: { key: Tab; label: string; match: (r: Review) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'counted', label: 'Counted', match: (r) => r.counted },
  { key: 'excluded', label: 'Excluded', match: (r) => !r.counted },
  { key: 'misconduct', label: 'Misconduct', match: (r) => r.tag1 === 'misconduct' },
];

export function ReviewList({ reviews }: { reviews: Review[] }) {
  const [tab, setTab] = useState<Tab>('all');
  const shown = useMemo(() => {
    const match = TABS.find((t) => t.key === tab)?.match ?? (() => true);
    return reviews.filter(match).toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [reviews, tab]);

  return (
    <div>
      <div className="chips" role="tablist" aria-label="Filter reviews">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`chip chip-toggle${tab === t.key ? ' is-on' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label} ({reviews.filter(t.match).length})
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <EmptyState
          message={reviews.length === 0 ? 'No reviews yet. Pay this agent, then be the first to review.' : 'No reviews in this view.'}
        />
      ) : (
        <div className="review-list">
          {shown.map((r) => (
            <ReviewCard key={`${r.clientAddress}-${r.feedbackIndex}`} review={r} />
          ))}
        </div>
      )}
    </div>
  );
}
