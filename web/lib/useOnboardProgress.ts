'use client';

import { useQuery } from '@tanstack/react-query';
import { BaseError, ContractFunctionRevertedError, zeroAddress, type Address, type Hash } from 'viem';
import { IDENTITY_REGISTRY, creatorRegistryAbi, identityRegistryAbi } from '@reputed/shared';
import { agentIdFromLogs } from './agentLogs';
import { chainClient } from './chainClient';
import { fetchTxOutcome } from './confirmTx';
import { CREATOR_REGISTRY } from './contracts';
import { findRegistration } from './mirror';
import type { OnboardDraft } from './onboardDraft';

export type OnboardProgress =
  /** Nothing on the chain yet. */
  | { state: 'none' }
  | { state: 'register-pending'; hash: Hash }
  /** The wallet was asked to register and no hash came back, and the Mirror Node has nothing so far. */
  | { state: 'register-unknown' }
  | { state: 'register-failed'; reason: string }
  /** Registered, owned by this wallet, and not linked: resume at the Link step. */
  | { state: 'unlinked'; agentId: string }
  | { state: 'linked'; agentId: string }
  /** The chain has no such agent, or it is not this wallet's. The stored ID cannot be used. */
  | { state: 'missing'; agentId: string }
  | { state: 'not-yours'; agentId: string };

const OWNER_READ_ATTEMPTS = 3;
const OWNER_READ_GAP_MS = 3_000;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const isRevert = (err: unknown) =>
  err instanceof BaseError && Boolean(err.walk((e) => e instanceof ContractFunctionRevertedError));

/**
 * A relay read can trail the Mirror Node just after registering, so "no such agent" is only believed
 * once it repeats. A read that fails for any other reason throws: it says nothing about the agent.
 */
async function readOwner(id: bigint): Promise<Address | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await chainClient.readContract({ address: IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: 'ownerOf', args: [id] });
    } catch (err) {
      if (!isRevert(err)) throw err;
      if (attempt === OWNER_READ_ATTEMPTS) return null;
      await new Promise((resolve) => setTimeout(resolve, OWNER_READ_GAP_MS));
    }
  }
}

async function checkAgent(wallet: Address, agentId: string): Promise<OnboardProgress> {
  const id = BigInt(agentId);
  const owner = await readOwner(id);
  if (owner === null) return { state: 'missing', agentId };

  const creator = await chainClient.readContract({ address: CREATOR_REGISTRY, abi: creatorRegistryAbi, functionName: 'creatorOf', args: [id] });
  if (same(creator, wallet)) return { state: 'linked', agentId };
  if (!same(creator, zeroAddress) || !same(owner, wallet)) return { state: 'not-yours', agentId };
  return { state: 'unlinked', agentId };
}

/** The chain's answer to "where did this draft get to?". Storage only says what to look up. */
async function readProgress(wallet: Address, draft: OnboardDraft, signal: AbortSignal): Promise<OnboardProgress> {
  if (draft.agentId !== undefined) return checkAgent(wallet, draft.agentId);

  if (draft.registerTx) {
    const outcome = await fetchTxOutcome(draft.registerTx, signal);
    if (outcome.status === 'unknown') return { state: 'register-pending', hash: draft.registerTx };
    if (outcome.status === 'reverted') return { state: 'register-failed', reason: outcome.reason };
    const agentId = agentIdFromLogs(outcome.logs);
    return agentId === null ? { state: 'none' } : checkAgent(wallet, agentId);
  }

  if (draft.registerStartedAt !== undefined && draft.pendingUri) {
    const agentId = await findRegistration(wallet, draft.pendingUri, draft.registerStartedAt, signal);
    // Absent from the Mirror Node is not the same as never sent: it lags, and the wallet may still be open.
    return agentId === null ? { state: 'register-unknown' } : checkAgent(wallet, agentId);
  }
  return { state: 'none' };
}

export const hasChainState = (draft: OnboardDraft): boolean =>
  draft.agentId !== undefined || Boolean(draft.registerTx) || (draft.registerStartedAt !== undefined && Boolean(draft.pendingUri));

/** `nonce` forces a fresh look. Results are not kept once unused, so a return visit reads the chain again. */
export function useOnboardProgress(wallet: Address | undefined, draft: OnboardDraft | null, nonce = 0) {
  return useQuery({
    queryKey: ['onboard-progress', wallet, draft?.agentId, draft?.registerTx, draft?.registerStartedAt, nonce],
    enabled: Boolean(wallet && draft && hasChainState(draft)),
    retry: 2,
    gcTime: 0,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) => readProgress(wallet as Address, draft as OnboardDraft, signal),
  });
}

/** The credential token's address, read from CreatorRegistry. */
export function useCredentialToken() {
  return useQuery({
    queryKey: ['credential-token'],
    retry: 2,
    staleTime: Infinity,
    queryFn: () => chainClient.readContract({ address: CREATOR_REGISTRY, abi: creatorRegistryAbi, functionName: 'credentialToken' }),
  });
}
