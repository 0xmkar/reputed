'use client';

import { useSyncExternalStore } from 'react';
import { isAddress, type Address } from 'viem';
import type { SessionResponse } from '@reputed/shared';

const KEY = 'reputed.session.v1';
const DECLINED = 'reputed.session.declined.';

/** The signed-in wallet. One at a time: signing in with another wallet replaces it. */
export type StoredSession = SessionResponse;

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedValue: StoredSession | null = null;

function parse(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<StoredSession>;
    const valid =
      typeof s.token === 'string' &&
      typeof s.wallet === 'string' &&
      isAddress(s.wallet) &&
      typeof s.expiresAt === 'number' &&
      s.expiresAt * 1000 > Date.now();
    return valid ? (s as StoredSession) : null;
  } catch {
    return null;
  }
}

/** Same object until the stored text changes, as useSyncExternalStore needs. */
function snapshot(): StoredSession | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // Storage blocked: the session lasts only until the page closes.
    return cachedValue;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedValue = parse(raw);
  }
  return cachedValue;
}

function notify() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab signing in or out.
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function getSession(): StoredSession | null {
  return snapshot();
}

export function saveSession(session: StoredSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    cachedRaw = undefined;
    cachedValue = session;
  }
  notify();
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith(DECLINED))
      .forEach((key) => sessionStorage.removeItem(key));
  } catch {
    // Nothing stored to clear.
  }
  cachedRaw = null;
  cachedValue = null;
  notify();
}

/** The stored session, or null on the server, on the first render, and once it expires. */
export function useStoredSession(): StoredSession | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** A refused sign-in is not asked again in this tab until the person connects a wallet themselves. */
export function markSignInDeclined(wallet: Address): void {
  try {
    sessionStorage.setItem(DECLINED + wallet.toLowerCase(), '1');
  } catch {
    // The prompt may repeat after a reload.
  }
}

export function wasSignInDeclined(wallet: Address): boolean {
  try {
    return sessionStorage.getItem(DECLINED + wallet.toLowerCase()) !== null;
  } catch {
    return false;
  }
}

export function allowSignInPrompt(): void {
  try {
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith(DECLINED))
      .forEach((key) => sessionStorage.removeItem(key));
  } catch {
    // Nothing to reset.
  }
}
