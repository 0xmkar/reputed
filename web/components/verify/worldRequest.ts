import {
  CredentialRequest,
  orbLegacy,
  type ConstraintNode,
  type Preset,
} from '@worldcoin/idkit';
import type { RpSignatureResponse } from '@reputed/shared';

export type WorldRequest = { allow_legacy_proofs: boolean } & (
  | { preset: Preset; constraints?: never }
  | { constraints: ConstraintNode; preset?: never }
);

/**
 * Asks for the one proof POST /api/verify accepts: an Orb credential, in the protocol version the
 * server names. The `proofOfHuman` preset is not used for 4.0 because it always allows a 3.0
 * fallback, which the server would then reject after the user had scanned.
 */
export function worldRequest(protocolVersion: RpSignatureResponse['protocol_version'], signal: string): WorldRequest {
  return protocolVersion === '4.0'
    ? { constraints: CredentialRequest('proof_of_human', { signal }), allow_legacy_proofs: false }
    : { preset: orbLegacy({ signal }), allow_legacy_proofs: true };
}
