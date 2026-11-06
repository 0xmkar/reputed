import { hashscan, type ExclusionReason, type Review } from '@reputed/shared';
import { formatDate } from '@/lib/format';
import { AddressChip } from './AddressChip';
import { CheckIcon, CrossIcon } from './icons';

const EXCLUSION_TEXT: Record<ExclusionReason, string> = {
  revoked: 'the reviewer revoked this review',
  'hash-mismatch': 'the review file does not match its on-chain hash',
  'not-human-backed': 'the reviewer is not human-backed',
  'payment-not-found': 'no matching payment was found',
  'same-creator': 'the reviewer shares the agent’s creator',
};

const HCS_URI = /^hcs:\/\/(\d+\.\d+\.\d+)\/(\d+)$/;

/** Where to send someone who wants to read the review file: a web URL as is, an hcs://<topic>/<sequence> URI as its HashScan topic page. */
function reviewFileHref(uri: string): string | null {
  if (uri.startsWith('https://') || uri.startsWith('http://')) return uri;
  const hcs = HCS_URI.exec(uri);
  return hcs?.[1] ? hashscan.topic(hcs[1]) : null;
}

export function ReviewCard({ review }: { review: Review }) {
  const fileHref = reviewFileHref(review.feedbackUri);
  // Review values are shown on a 0-100 bar; anything outside is clamped for the bar only.
  const barWidth = Math.min(100, Math.max(0, review.value));
  return (
    <article className={`card review-card${review.counted ? '' : ' is-excluded'}`}>
      <header className="review-head">
        <div className="review-who">
          <AddressChip address={review.clientAddress} />
          {review.reviewerHumanBacked && (
            <span className="badge badge-verified" title="Linked to a unique World ID–verified creator">
              Human-backed
            </span>
          )}
        </div>
        <span className={`badge ${review.counted ? 'badge-verified' : 'tier-3'}`}>
          {review.counted ? 'Counted' : 'Excluded'}
        </span>
      </header>

      <div className="review-value" aria-label={`Review value ${review.value}`}>
        <span className="review-number">{review.value}</span>
        <span className="bar" aria-hidden="true">
          <span className="bar-fill" style={{ width: `${barWidth}%` }} />
        </span>
      </div>

      <div className="chips">
        {review.tag1 && <span className={`chip${review.tag1 === 'misconduct' ? ' chip-warn' : ''}`}>{review.tag1}</span>}
        {review.tag2 && <span className="chip">{review.tag2}</span>}
      </div>

      {review.comment && <p className="review-comment">{review.comment}</p>}

      {!review.counted && review.exclusionReason && (
        <p className="muted">Not counted: {EXCLUSION_TEXT[review.exclusionReason]}.</p>
      )}

      <footer className="review-foot">
        <span className="muted">{formatDate(review.createdAt)}</span>
        <span className={review.paymentVerified ? 'pay-ok' : 'muted'}>
          {review.paymentVerified ? <CheckIcon /> : <CrossIcon />} Payment {review.paymentVerified ? 'verified' : 'not verified'}
        </span>
        <a href={hashscan.tx(review.txId)} target="_blank" rel="noreferrer">
          Transaction
        </a>
        {fileHref && (
          <a href={fileHref} target="_blank" rel="noreferrer">
            Review file
          </a>
        )}
      </footer>
    </article>
  );
}
