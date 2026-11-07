import { formatDateTime } from '@/lib/format';

/** Amber chip shown when the server says the latest snapshot is old. Pass `updatedAt` when the page has a timestamp. */
export function StaleScoresChip({ updatedAt }: { updatedAt?: string }) {
  return (
    <span className="chip chip-warn stale-chip" role="status">
      {updatedAt ? `Scores last updated ${formatDateTime(updatedAt)}` : 'Scores may be out of date'}
    </span>
  );
}
