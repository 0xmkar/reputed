import type { WorldConfig } from '../config.ts';
import type { CheckedProof, IdkitResult } from './proof.ts';

// World ID 4.0 cloud verify, as documented on 2026-11-06 for IDKit 4.x (4.6.0):
//   POST https://developer.world.org/api/v4/verify/{rp_id}
//   https://docs.world.org/api-reference/developer-portal/verify
//   https://docs.world.org/world-id/idkit/integrate (step 5)
// The IDKit result is forwarded unchanged. The v2 endpoint is legacy.

export type WorldVerdict = { kind: 'verified' } | { kind: 'invalid' } | { kind: 'unavailable' };

export interface WorldVerifier {
  verify(result: IdkitResult, proof: CheckedProof): Promise<WorldVerdict>;
}

const PROOF_FAILURES = new Set([
  'invalid_proof',
  'invalid_merkle_root',
  'root_too_old',
  'verification_error',
  'environment_mismatch',
  'validation_error',
  'invalid',
  'required',
]);

// Per-proof codes that mean the proof itself is bad. World reports its own RPC or
// prover failures in the same list, as verification_failed, generic_error,
// prover_error or internal_error, under the same all_verifications_failed.
const ITEM_PROOF_FAILURES = new Set([
  'invalid_proof',
  'invalid_root',
  'invalid_merkle_root',
  'root_too_old',
  'outdated_nullifier',
  'nullifier_from_future',
  'invalid_credential_issuer',
  'invalid_public_input',
  'invalid_format',
  'verification_error',
]);

interface WorldItem {
  identifier?: string;
  success?: boolean;
  code?: string;
}

interface WorldBody {
  success?: boolean;
  code?: string;
  action?: string;
  environment?: string;
  nullifier?: string;
  results?: WorldItem[];
}

/**
 * Anything not positively a bad proof counts as unavailable. Live, a wrong RP ID
 * returns HTTP 400 `app_not_migrated` rather than the documented 404, so the
 * status alone cannot separate a bad proof from a misconfigured server.
 */
function classifyFailure(body: WorldBody): WorldVerdict {
  const badProof =
    body.code === 'all_verifications_failed'
      ? body.results?.some((item) => item.code && ITEM_PROOF_FAILURES.has(item.code))
      : body.code !== undefined && PROOF_FAILURES.has(body.code);
  return badProof ? { kind: 'invalid' } : { kind: 'unavailable' };
}

function confirmsProof(body: WorldBody, proof: CheckedProof, world: WorldConfig): boolean {
  if (body.success !== true || body.environment !== world.environment) return false;
  if (body.action !== undefined && body.action !== world.action) return false;
  if (body.nullifier !== undefined && BigInt(body.nullifier) !== proof.nullifier) return false;
  return (
    body.results?.some((item) => item.identifier === proof.identifier && item.success === true) ??
    false
  );
}

export function createWorldClient(
  world: WorldConfig,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): WorldVerifier {
  const { fetch: doFetch = fetch, timeoutMs = 10_000 } = options;
  const url = `${world.apiBase}/api/v4/verify/${world.rpId}`;

  return {
    async verify(result, proof) {
      let status: number;
      let body: WorldBody;
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...result, environment: world.environment }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        body = (await res.json()) as WorldBody;
      } catch {
        return { kind: 'unavailable' };
      }

      if (status === 200) {
        try {
          return confirmsProof(body, proof, world)
            ? { kind: 'verified' }
            : { kind: 'unavailable' };
        } catch {
          return { kind: 'unavailable' };
        }
      }
      return status === 400 ? classifyFailure(body) : { kind: 'unavailable' };
    },
  };
}
