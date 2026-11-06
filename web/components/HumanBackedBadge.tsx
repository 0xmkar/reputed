import { hashscan } from '@reputed/shared';
import { ShieldIcon } from './icons';

interface Props {
  /** When given, the badge links to the credential NFT on HashScan. */
  credential?: { tokenId: string; serial: number };
}

const TOOLTIP = 'Linked to a unique World ID–verified creator';

export function HumanBackedBadge({ credential }: Props) {
  const content = (
    <>
      <ShieldIcon /> Human-backed
    </>
  );
  if (!credential) {
    return (
      <span className="badge badge-verified" title={TOOLTIP}>
        {content}
      </span>
    );
  }
  return (
    <a
      className="badge badge-verified badge-link"
      title={TOOLTIP}
      href={hashscan.nft(credential.tokenId, credential.serial)}
      target="_blank"
      rel="noreferrer"
    >
      {content}
    </a>
  );
}
