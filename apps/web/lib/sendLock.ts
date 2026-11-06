import { notSent } from './walletError';

/**
 * Runs `work` while holding a lock shared by every tab, and refuses if another tab holds it, so only
 * one tab can be mid-send. The browser drops the lock if the tab dies. Web Locks need a secure context,
 * and without them the caller's own check of stored state is what stands in the way of a second send.
 */
export async function withSendLock<T>(name: string, busyMessage: string, work: () => Promise<T>): Promise<T> {
  if (!('locks' in navigator)) return work();
  return navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
    if (!lock) throw notSent(busyMessage);
    return work();
  }) as Promise<T>;
}
