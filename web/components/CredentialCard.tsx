import { hashscan, type Credential } from '@reputed/shared';
import { formatDate } from '@/lib/format';
import { LockIcon } from './icons';

export function CredentialCard({ credential }: { credential: Credential }) {
  return (
    <article className={`card credential-card${credential.revoked ? ' is-revoked' : ''}`}>
      <header className="credential-head">
        <h3>{credential.title}</h3>
        {credential.revoked ? (
          <span className="badge tier-3">Revoked</span>
        ) : (
          <span className="badge badge-verified">Active</span>
        )}
      </header>
      <dl className="credential-meta">
        <div>
          <dt>Issued</dt>
          <dd>{formatDate(credential.issuedAt)}</dd>
        </div>
        <div>
          <dt>Serial</dt>
          <dd className="mono">#{credential.serial}</dd>
        </div>
      </dl>
      <footer className="credential-foot">
        <span className="muted">
          <LockIcon /> Non-transferable
        </span>
        <a href={hashscan.nft(credential.tokenId, credential.serial)} target="_blank" rel="noreferrer">
          View on HashScan
        </a>
      </footer>
    </article>
  );
}
