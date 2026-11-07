import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * What a crashed onboarding needs to carry on without registering a second agent: the transaction
 * is written down before it is sent.
 */
export interface OnboardState {
  agentId?: string;
  pendingRegistration?: { uri: string; transactionId?: string; startedAt: number };
  pendingLink?: { transactionId: string; startedAt: number };
  serial?: number;
}

export interface StateStore {
  load(key: string): OnboardState;
  save(key: string, state: OnboardState): void;
}

/** Cloned on the way in and out, so a caller holding a reference cannot change what was saved. */
export class MemoryStateStore implements StateStore {
  readonly #states = new Map<string, OnboardState>();
  load(key: string): OnboardState {
    return structuredClone(this.#states.get(key) ?? {});
  }
  save(key: string, state: OnboardState): void {
    this.#states.set(key, structuredClone(state));
  }
}

/**
 * One JSON file, keyed by network, registry and account. Written whole, then renamed into place, so a
 * crash mid-write leaves the previous file rather than a truncated one. An unreadable file reads as
 * empty: onboarding then falls back to what the chain says.
 */
export class FileStateStore implements StateStore {
  constructor(readonly path: string) {}

  #readAll(): Record<string, OnboardState> {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, OnboardState>;
    } catch {
      return {};
    }
  }

  load(key: string): OnboardState {
    return this.#readAll()[key] ?? {};
  }

  save(key: string, state: OnboardState): void {
    const all = this.#readAll();
    all[key] = state;
    mkdirSync(dirname(this.path), { recursive: true });
    // The pid keeps two processes from sharing a temp file. 0600 although the file holds only IDs, never the key.
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
