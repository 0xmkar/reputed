'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccount } from 'wagmi';
import { loadDraft, type OnboardDraft } from '@/lib/onboardDraft';
import { useOnboardProgress } from '@/lib/useOnboardProgress';

/** Shown on every page but the wizard itself, and only once the chain confirms the agent is still unlinked. */
export function ResumeBanner() {
  const { address } = useAccount();
  const pathname = usePathname();
  const onWizard = pathname === '/onboard';
  const [draft, setDraft] = useState<OnboardDraft | null>(null);

  // Effect, not render: the server has no storage. The path is a dependency so leaving the wizard reloads the draft.
  useEffect(() => {
    setDraft(address && !onWizard ? loadDraft(address) : null);
  }, [address, onWizard]);

  const progress = useOnboardProgress(address, draft);
  if (onWizard || progress.data?.state !== 'unlinked') return null;

  return (
    <div className="banner" role="status">
      <span>Agent #{progress.data.agentId} is registered but not linked to you yet.</span>
      <Link href="/onboard" className="btn btn-primary btn-small">
        Resume
      </Link>
    </div>
  );
}
