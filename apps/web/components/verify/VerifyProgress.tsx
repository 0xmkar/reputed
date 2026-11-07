import { hashscan, type VerifyResponse } from '@reputed/shared';
import { CheckIcon } from '@/components/icons';

interface Props {
  /** True once the server has answered. It sends the transaction inside that one request. */
  submitted: boolean;
  tx: VerifyResponse | null;
  slow: boolean;
  onRefresh: () => void;
}

function Mark({ done }: { done: boolean }) {
  return <span className="verify-progress-mark">{done ? <CheckIcon /> : null}</span>;
}

export function VerifyProgress({ submitted, tx, slow, onRefresh }: Props) {
  return (
    <ol className="verify-progress" role="status">
      <li className={submitted ? 'is-done' : 'is-active'}>
        <Mark done={submitted} />
        <span>Verifying proof…</span>
      </li>
      <li className={submitted ? 'is-active' : undefined}>
        <Mark done={false} />
        <div>
          <span>Registering on Hedera…</span>
          {submitted && (
            <p className="muted verify-note">
              Confirming on Hedera — usually a few seconds
              {tx && (
                <>
                  {' · '}
                  <a href={hashscan.tx(tx.transactionHash)} target="_blank" rel="noreferrer">
                    View transaction
                  </a>
                </>
              )}
            </p>
          )}
          {submitted && slow && (
            <p className="verify-note row">
              <span>Taking longer than usual</span>
              <button type="button" className="btn btn-outline btn-small" onClick={onRefresh}>
                Refresh
              </button>
            </p>
          )}
        </div>
      </li>
      <li>
        <Mark done={false} />
        <span>Done</span>
      </li>
    </ol>
  );
}
