// Log ingestion. Each source (identity, reputation, creatorRegistry) has its own cursor: the
// consensus timestamp of the last log on the last page saved. Nothing is deleted or rewritten
// on ingest, since Hedera consensus is final; rows only ever accumulate. Lag is handled by the
// caller: ScorerRuntime.sync reads the mirror's latest ingested time before this runs and folds
// only events at or below it, so logs newer than that time wait for the next sync even when a
// page has already returned them.
import { decodeLog, type EventSource } from './decode.ts';
import type { MirrorClient } from './mirror.ts';
import type { Store } from './store.ts';

export interface LogSource {
  source: EventSource;
  address: string;
}

/**
 * Resumes from the saved timestamp with gte, not gt: one consensus timestamp can hold several logs
 * and a page can end between them. Re-read rows are ignored by the primary key.
 */
export async function ingestSource(
  store: Store,
  mirror: MirrorClient,
  { source, address }: LogSource,
): Promise<number> {
  let path: string | null = mirror.firstLogsPath(address, store.cursor(source));
  let added = 0;
  while (path) {
    const page = await mirror.logsPage(path);
    const events = page.logs.flatMap((log) => decodeLog(source, log) ?? []);
    added += store.saveLogPage(source, events, page.logs.at(-1)?.timestamp ?? null);
    path = page.next;
  }
  return added;
}

export async function ingestAll(
  store: Store,
  mirror: MirrorClient,
  sources: LogSource[],
): Promise<number> {
  let added = 0;
  for (const source of sources) added += await ingestSource(store, mirror, source);
  return added;
}
