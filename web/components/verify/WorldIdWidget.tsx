'use client';

import { useMemo } from 'react';
import { IDKitRequestWidget } from '@worldcoin/idkit';
import type { Address, RpSignatureResponse } from '@reputed/shared';
import { worldRequest } from './worldRequest';

interface Props {
  appId: `app_${string}`;
  rp: RpSignatureResponse;
  wallet: Address;
  onResult: (result: unknown) => void;
  onError: (code: string) => void;
  onClosed: () => void;
}

/**
 * The IDKit modal: a QR code on desktop, a World App link on mobile. The page posts the proof
 * itself rather than through `handleVerify`, because the modal's own Retry would reuse this
 * request's nonce and the page's status list needs to show the server's progress.
 */
export default function WorldIdWidget({ appId, rp, wallet, onResult, onError, onClosed }: Props) {
  const request = useMemo(() => worldRequest(rp.protocol_version, wallet), [rp.protocol_version, wallet]);

  return (
    <IDKitRequestWidget
      open
      onOpenChange={(open) => {
        if (!open) onClosed();
      }}
      app_id={appId}
      action={rp.action}
      rp_context={rp.rp_context}
      environment={rp.environment}
      onSuccess={onResult}
      onError={onError}
      {...request}
    />
  );
}
