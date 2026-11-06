import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVerificationStore } from '../src/verificationStore.ts';
import { CREATOR_A, CREATOR_B, N1, REGISTRY } from './helpers.ts';

const scope = { registry: REGISTRY, action: 'agent-creator-v1' };

describe('createVerificationStore', () => {
  it('moves a nullifier from verified to registered', () => {
    const store = createVerificationStore(':memory:', scope);
    expect(store.byNullifier(N1)).toBeUndefined();

    store.saveVerified(N1, CREATOR_A);
    expect(store.byNullifier(N1)).toEqual({ wallet: CREATOR_A, status: 'verified' });
    expect(store.isRegisteredWallet(CREATOR_A)).toBe(false);

    store.saveRegistered(N1, CREATOR_A);
    expect(store.byNullifier(N1)?.status).toBe('registered');
    expect(store.isRegisteredWallet(CREATOR_A)).toBe(true);
    expect(store.isRegisteredWallet(CREATOR_B)).toBe(false);
  });

  it('lets a newer verified attempt replace a stale one', () => {
    const store = createVerificationStore(':memory:', scope);
    store.saveVerified(N1, CREATOR_A);
    store.saveVerified(N1, CREATOR_B);
    expect(store.byNullifier(N1)).toEqual({ wallet: CREATOR_B, status: 'verified' });
  });

  it('survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reputed-store-'));
    try {
      const path = join(dir, 'nested', 'verifier.sqlite');
      const first = createVerificationStore(path, scope);
      first.saveVerified(N1, CREATOR_A);
      first.close();

      const second = createVerificationStore(path, scope);
      expect(second.byNullifier(N1)?.wallet).toBe(CREATOR_A);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts clean for a redeployed registry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reputed-store-'));
    try {
      const path = join(dir, 'verifier.sqlite');
      const old = createVerificationStore(path, scope);
      old.saveRegistered(N1, CREATOR_A);
      old.close();

      const fresh = createVerificationStore(path, { ...scope, registry: CREATOR_B });
      expect(fresh.byNullifier(N1)).toBeUndefined();
      expect(fresh.isRegisteredWallet(CREATOR_A)).toBe(false);
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
