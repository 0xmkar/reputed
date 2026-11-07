// The epoch loop: sync, reconcile with the topic once per process, publish the config once per
// series, then publish every complete epoch not yet on the topic. A tick that throws is logged
// and retried after pollMs; nothing counts as published until the HCS receipt returns. Epochs
// are judged against the mirror's consensus time, not the wall clock, so the loop cannot
// publish an epoch the mirror has not finished ingesting.
import { loadHederaConfig } from '../config.ts';
import { logReason } from '../errors.ts';
import { MirrorError } from '../indexer/mirror.ts';
import { getScorerRuntime, type ScorerRuntime } from '../indexer/runtime.ts';
import { missingForLoop } from '../indexer/settings.ts';
import { canonicalJson, epochOf, hasOnlyFiniteScores } from './snapshot.ts';
import type { ConsensusTimestamp } from './time.ts';
import { createSnapshotPublisher, readLatestSnapshot, type SnapshotPublisher } from './topic.ts';
import type { Snapshot } from './types.ts';

export interface LoopLog {
  info(message: string): void;
  error(message: string): void;
}

export interface EpochLoop {
  tick(): Promise<void>;
  stop(): Promise<void>;
}

const CONFIG_PUBLISHED = (version: number, epochSeconds: number) =>
  `config_published:${version}:${epochSeconds}`;

// SDK errors can quote request data, so only Mirror Node errors keep their whole message.
function describe(err: unknown): string {
  return err instanceof MirrorError ? err.message : logReason(err);
}

export function createEpochLoop(
  runtime: ScorerRuntime,
  publisher: SnapshotPublisher,
  log: LoopLog = { info: console.info, error: console.error },
): EpochLoop {
  const { store, settings, config, mirror } = runtime;
  let reconciled = false;

  // An epoch number counts in units of epochSeconds, so another series' numbers say nothing here:
  // one from a 60-second run would otherwise look centuries ahead of an hourly clock.
  const inThisSeries = (snapshot: Snapshot) =>
    snapshot.configVersion === config.configVersion &&
    snapshot.epochSeconds === config.epochSeconds;

  /**
   * Picks up what the last process left on the topic. This is what stops a crash between publish
   * and save, or a wiped cache, from publishing an epoch twice. It also proves T5.8 on real data:
   * a rebuilt epoch must reproduce the published inputsHash.
   */
  async function reconcile(): Promise<void> {
    const published = await readLatestSnapshot(mirror, settings.scoresTopicId, inThisSeries);
    if (published) {
      const { snapshot, sequenceNumber } = published;
      const rebuilt = runtime.buildEpoch(snapshot.epoch);
      if (rebuilt.snapshot.inputsHash === snapshot.inputsHash) {
        log.info(`scorer: epoch ${snapshot.epoch} rebuilt, inputsHash matches the topic`);
      } else {
        log.error(`scorer: epoch ${snapshot.epoch} rebuilt, inputsHash differs from the topic`);
      }
      store.saveSnapshot(snapshot, sequenceNumber);
    }
    reconciled = true;
  }

  async function publishConfig(): Promise<void> {
    const key = CONFIG_PUBLISHED(config.configVersion, config.epochSeconds);
    if (store.getMeta(key)) return;
    await publisher.publish(canonicalJson({ type: 'scorer-config', ...config }));
    store.setMeta(key, '1');
  }

  async function publishEpoch(epoch: number): Promise<boolean> {
    const { snapshot, pending } = runtime.buildEpoch(epoch);
    if (pending > 0) {
      log.error(`scorer: epoch ${epoch} waits on ${pending} reviews`);
      return false;
    }
    if (!hasOnlyFiniteScores(snapshot)) {
      log.error(`scorer: epoch ${epoch} has a non-finite score, not publishing it`);
      return false;
    }
    store.saveSnapshot(snapshot, null);
    const { sequenceNumber } = await publisher.publish(canonicalJson(snapshot));
    store.saveSnapshot(snapshot, sequenceNumber);
    log.info(`scorer: published epoch ${epoch} as message ${sequenceNumber}`);
    return true;
  }

  /** Scores are a pure function of the epoch, so a missed one published late is still correct. */
  async function publishDue(now: ConsensusTimestamp): Promise<void> {
    const complete = epochOf(now, config);
    const last = store.latestPublishedSnapshot(config)?.epoch ?? null;
    if (last !== null && last > complete) {
      log.error(`scorer: epoch ${last} is published, but the mirror is only at epoch ${complete}`);
    }
    if (last !== null && last >= complete) return;

    const oldest = complete - settings.maxBackfillEpochs + 1;
    const first = last === null ? complete : Math.max(last + 1, oldest);
    if (last !== null && first > last + 1) {
      log.error(`scorer: skipping epochs ${last + 1}-${first - 1}, beyond the backfill limit`);
    }
    for (let epoch = first; epoch <= complete; epoch += 1) {
      if (!(await publishEpoch(epoch))) return;
    }
  }

  async function tick(): Promise<void> {
    const now = await runtime.sync();
    if (!reconciled) await reconcile();
    await publishConfig();
    await publishDue(now);
  }

  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  function schedule(delayMs: number): void {
    timer = setTimeout(() => {
      running = tick()
        .catch((err) => log.error(`scorer: tick failed, will retry: ${describe(err)}`))
        .finally(() => {
          if (!stopped) schedule(settings.pollMs);
        });
    }, delayMs);
  }
  schedule(0);

  return {
    tick,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}

/** Starts indexing and epoch publishing. Throws at once if a required setting is missing. */
export function startEpochLoop(options: { log?: LoopLog } = {}): EpochLoop {
  const runtime = getScorerRuntime();
  const missing = missingForLoop(runtime.settings);
  if (missing.length > 0) {
    throw new Error(`Scorer cannot start. Missing: ${missing.join(', ')}`);
  }
  const publisher = createSnapshotPublisher(loadHederaConfig(), runtime.settings.scoresTopicId);
  return createEpochLoop(runtime, publisher, options.log);
}
