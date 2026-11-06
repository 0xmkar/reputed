import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConsensusTimestamp } from '../scoring/time.ts';
import type { Snapshot } from '../scoring/types.ts';
import type { ChainEvent, EventArgs, EventSource } from './decode.ts';
import type { AccountRecord, MirrorTransaction } from './mirror.ts';

const SCHEMA_VERSION = '2';
const META_TABLE = 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);';
const DROP_CACHE = `
DELETE FROM meta;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS review_files;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS agent_files;
DROP TABLE IF EXISTS tracked_agents;
DROP TABLE IF EXISTS snapshots;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  source TEXT NOT NULL,
  ts TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  args TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  PRIMARY KEY (source, ts, log_index)
);
CREATE INDEX IF NOT EXISTS events_by_time ON events (ts, log_index);
CREATE TABLE IF NOT EXISTS review_files (
  uri TEXT PRIMARY KEY,
  message TEXT,
  consensus_ts TEXT,
  fetched_through TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  proof TEXT PRIMARY KEY,
  transactions TEXT NOT NULL,
  fetched_through TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  evm TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_files (
  uri TEXT PRIMARY KEY,
  body TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tracked_agents (agent_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS snapshots (
  epoch INTEGER PRIMARY KEY,
  config_version INTEGER NOT NULL,
  inputs_hash TEXT NOT NULL,
  body TEXT NOT NULL,
  sequence_number INTEGER
);
`;

export interface ReviewFileFact {
  message: string;
  consensusTimestamp: ConsensusTimestamp;
}

/** fetchedThrough: the lookup saw everything that reached consensus up to this time. */
export interface ReviewFileRecord {
  /** Null when the mirror had no such message. */
  fact: ReviewFileFact | null;
  fetchedThrough: ConsensusTimestamp;
}

export interface PaymentRecord {
  transactions: MirrorTransaction[];
  fetchedThrough: ConsensusTimestamp;
}

/** Facts already fetched. undefined means never fetched. */
export interface Facts {
  reviewFile(uri: string): ReviewFileRecord | undefined;
  payment(proofKey: string): PaymentRecord | undefined;
  account(evm: string): AccountRecord | undefined;
}

/** A snapshot's epoch number only means something alongside these two. */
export interface SnapshotSeries {
  configVersion: number;
  epochSeconds: number;
}

export interface SnapshotRow {
  epoch: number;
  inputsHash: string;
  snapshot: Snapshot;
  sequenceNumber: number | null;
}

interface EventRow {
  source: string;
  ts: string;
  log_index: number;
  name: string;
  args: string;
  tx_hash: string;
}

export class Store implements Facts {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(META_TABLE);
    // Everything here can be rebuilt from the mirror and the scores topic.
    if (this.getMeta('schema_version') !== SCHEMA_VERSION) this.db.exec(DROP_CACHE);
    this.db.exec(SCHEMA);
    this.setMeta('schema_version', SCHEMA_VERSION);
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  cursor(source: EventSource): ConsensusTimestamp | null {
    return this.getMeta(`cursor:${source}`);
  }

  /**
   * Events and cursors belong to one contract. When the configured address changes, what the old
   * one emitted is dropped, or the fold would mix it into data the new contract cannot reproduce.
   * Returns true if anything was reset.
   */
  bindSource(source: EventSource, address: string | null): boolean {
    const key = `address:${source}`;
    const next = address?.toLowerCase() ?? '';
    const bound = this.getMeta(key) ?? '';
    if (bound === next) return false;

    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM events WHERE source = ?').run(source);
      this.db.prepare('DELETE FROM meta WHERE key = ?').run(`cursor:${source}`);
      this.setMeta(key, next);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return bound !== '';
  }

  /** One transaction per page, so a crash can never advance the cursor past unsaved events. */
  saveLogPage(source: EventSource, events: ChainEvent[], cursor: ConsensusTimestamp | null): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO events (source, ts, log_index, name, args, tx_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      let added = 0;
      for (const event of events) {
        const change = insert.run(
          source,
          event.timestamp,
          event.logIndex,
          event.name,
          JSON.stringify(event.args),
          event.txHash,
        );
        added += Number(change.changes);
      }
      if (cursor) this.setMeta(`cursor:${source}`, cursor);
      this.db.exec('COMMIT');
      return added;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  eventsUpTo(asOf: ConsensusTimestamp): ChainEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE ts <= ? ORDER BY ts, log_index, source')
      .all(asOf) as unknown as EventRow[];
    return rows.map((row) => ({
      source: row.source as EventSource,
      name: row.name,
      args: JSON.parse(row.args) as EventArgs,
      timestamp: row.ts,
      logIndex: row.log_index,
      txHash: row.tx_hash,
    }));
  }

  reviewFile(uri: string): ReviewFileRecord | undefined {
    const row = this.db
      .prepare('SELECT message, consensus_ts, fetched_through FROM review_files WHERE uri = ?')
      .get(uri) as
      | { message: string | null; consensus_ts: string | null; fetched_through: string }
      | undefined;
    if (!row) return undefined;
    const fact =
      row.message === null || row.consensus_ts === null
        ? null
        : { message: row.message, consensusTimestamp: row.consensus_ts };
    return { fact, fetchedThrough: row.fetched_through };
  }

  saveReviewFile(
    uri: string,
    fact: ReviewFileFact | null,
    fetchedThrough: ConsensusTimestamp,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO review_files (uri, message, consensus_ts, fetched_through)
         VALUES (?, ?, ?, ?)`,
      )
      .run(uri, fact?.message ?? null, fact?.consensusTimestamp ?? null, fetchedThrough);
  }

  payment(proofKey: string): PaymentRecord | undefined {
    const row = this.db
      .prepare('SELECT transactions, fetched_through FROM payments WHERE proof = ?')
      .get(proofKey) as { transactions: string; fetched_through: string } | undefined;
    if (!row) return undefined;
    return {
      transactions: JSON.parse(row.transactions) as MirrorTransaction[],
      fetchedThrough: row.fetched_through,
    };
  }

  savePayment(
    proofKey: string,
    transactions: MirrorTransaction[],
    fetchedThrough: ConsensusTimestamp,
  ): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO payments (proof, transactions, fetched_through) VALUES (?, ?, ?)',
      )
      .run(proofKey, JSON.stringify(transactions), fetchedThrough);
  }

  account(evm: string): AccountRecord | undefined {
    const row = this.db
      .prepare('SELECT account_id, created_ts FROM accounts WHERE evm = ?')
      .get(evm) as { account_id: string; created_ts: string } | undefined;
    return row && { accountId: row.account_id, createdAt: row.created_ts };
  }

  saveAccount(evm: string, record: AccountRecord): void {
    this.db
      .prepare('INSERT OR REPLACE INTO accounts (evm, account_id, created_ts) VALUES (?, ?, ?)')
      .run(evm, record.accountId, record.createdAt);
  }

  agentFile(uri: string): { body: string | null; fetchedAt: number } | undefined {
    const row = this.db
      .prepare('SELECT body, fetched_at FROM agent_files WHERE uri = ?')
      .get(uri) as { body: string | null; fetched_at: number } | undefined;
    return row && { body: row.body, fetchedAt: row.fetched_at };
  }

  saveAgentFile(uri: string, body: string | null, fetchedAt: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO agent_files (uri, body, fetched_at) VALUES (?, ?, ?)')
      .run(uri, body, fetchedAt);
  }

  trackedAgents(): string[] {
    const rows = this.db.prepare('SELECT agent_id FROM tracked_agents').all() as unknown as {
      agent_id: string;
    }[];
    return rows.map((row) => row.agent_id);
  }

  trackAgent(agentId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO tracked_agents (agent_id) VALUES (?)').run(agentId);
  }

  saveSnapshot(snapshot: Snapshot, sequenceNumber: number | null): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (epoch, config_version, inputs_hash, body, sequence_number)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (epoch) DO UPDATE SET
           config_version = excluded.config_version,
           inputs_hash = excluded.inputs_hash,
           body = excluded.body,
           sequence_number = COALESCE(excluded.sequence_number, snapshots.sequence_number)`,
      )
      .run(
        snapshot.epoch,
        snapshot.configVersion,
        snapshot.inputsHash,
        JSON.stringify(snapshot),
        sequenceNumber,
      );
  }

  private snapshotRow(sql: string, ...params: number[]): SnapshotRow | null {
    const row = this.db.prepare(sql).get(...params) as
      | { epoch: number; inputs_hash: string; body: string; sequence_number: number | null }
      | undefined;
    if (!row) return null;
    return {
      epoch: row.epoch,
      inputsHash: row.inputs_hash,
      snapshot: JSON.parse(row.body) as Snapshot,
      sequenceNumber: row.sequence_number,
    };
  }

  snapshot(epoch: number): SnapshotRow | null {
    return this.snapshotRow('SELECT * FROM snapshots WHERE epoch = ?', epoch);
  }

  /** Pass a series when comparing epoch numbers: those of another series are not comparable. */
  latestPublishedSnapshot(series?: SnapshotSeries): SnapshotRow | null {
    if (!series) {
      return this.snapshotRow(
        'SELECT * FROM snapshots WHERE sequence_number IS NOT NULL ORDER BY epoch DESC LIMIT 1',
      );
    }
    return this.snapshotRow(
      `SELECT * FROM snapshots
       WHERE sequence_number IS NOT NULL
         AND config_version = ?
         AND json_extract(body, '$.epochSeconds') = ?
       ORDER BY epoch DESC LIMIT 1`,
      series.configVersion,
      series.epochSeconds,
    );
  }
}
