import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Address, Hex } from 'viem';

export type VerificationStatus = 'verified' | 'registered';

export interface VerificationRecord {
  wallet: Address;
  status: VerificationStatus;
}

export interface VerificationStore {
  byNullifier(nullifierHash: Hex): VerificationRecord | undefined;
  isRegisteredWallet(wallet: Address): boolean;
  /** The proof passed World but is not on-chain yet. */
  saveVerified(nullifierHash: Hex, wallet: Address): void;
  saveRegistered(nullifierHash: Hex, wallet: Address): void;
  close(): void;
}

/**
 * The contract stays the source of truth. This record covers two gaps it cannot:
 *
 * - An attempt can pass World and then fail on-chain. A 'verified' row lets the
 *   same wallet finish it without World, so a retry works during a World outage.
 *   The row binds nobody: World answers 200 to a nullifier it has seen, so a new
 *   proof for another wallet is checked with World and replaces the row.
 * - Relay reads are served from the mirror node, seconds behind consensus.
 *   'registered' rows answer a replay in that window without paying for a
 *   transaction that would revert.
 *
 * Rows hold only a nullifier hash and a wallet, both public once registered, and
 * are scoped to a registry and action so a redeploy starts clean.
 */
export function createVerificationStore(
  path: string,
  scope: { registry: Address; action: string },
): VerificationStore {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS verifications (
      registry TEXT NOT NULL,
      action TEXT NOT NULL,
      nullifier_hash TEXT NOT NULL,
      wallet TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('verified', 'registered')),
      PRIMARY KEY (registry, action, nullifier_hash)
    );
    CREATE INDEX IF NOT EXISTS verifications_wallet ON verifications (registry, action, wallet);
  `);

  const { registry, action } = scope;
  const select = db.prepare(
    'SELECT wallet, status FROM verifications WHERE registry = ? AND action = ? AND nullifier_hash = ?',
  );
  const selectWallet = db.prepare(
    `SELECT 1 FROM verifications
     WHERE registry = ? AND action = ? AND wallet = ? AND status = 'registered'`,
  );
  const upsert = db.prepare(`
    INSERT INTO verifications (registry, action, nullifier_hash, wallet, status)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (registry, action, nullifier_hash)
    DO UPDATE SET wallet = excluded.wallet, status = excluded.status
  `);

  return {
    byNullifier: (nullifierHash) =>
      select.get(registry, action, nullifierHash) as VerificationRecord | undefined,
    isRegisteredWallet: (wallet) => selectWallet.get(registry, action, wallet) !== undefined,
    saveVerified: (nullifierHash, wallet) => {
      upsert.run(registry, action, nullifierHash, wallet, 'verified');
    },
    saveRegistered: (nullifierHash, wallet) => {
      upsert.run(registry, action, nullifierHash, wallet, 'registered');
    },
    close: () => db.close(),
  };
}
