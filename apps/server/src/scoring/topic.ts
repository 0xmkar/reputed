// The scores HCS topic: publishing snapshots, chunked when over 1,024 bytes, and reading the
// newest one back. readLatestSnapshot groups chunks by their initial transaction ID and parses
// a group only once every chunk is present, so a config message or a half-read snapshot is
// never taken for the latest.
import { TopicMessageSubmitTransaction } from '@hashgraph/sdk';
import type { HederaConfig } from '../config.ts';
import { createOperatorClient } from '../hedera.ts';
import type { MirrorClient, TopicMessage } from '../indexer/mirror.ts';
import { chunksNeeded } from './snapshot.ts';
import type { Snapshot } from './types.ts';

export interface PublishResult {
  sequenceNumber: number;
}

export interface SnapshotPublisher {
  publish(message: string): Promise<PublishResult>;
}

export function buildSnapshotMessage(topicId: string, message: string) {
  return new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(message)
    .setMaxChunks(chunksNeeded(message));
}

export function createSnapshotPublisher(config: HederaConfig, topicId: string): SnapshotPublisher {
  let client: ReturnType<typeof createOperatorClient> | undefined;

  return {
    async publish(message) {
      client ??= createOperatorClient(config).catch((err) => {
        client = undefined;
        throw err;
      });
      const hedera = await client;

      // One transaction per chunk. The number kept is the last chunk's, which is also the max
      // readLatestSnapshot reports for the group.
      const responses = await buildSnapshotMessage(topicId, message).executeAll(hedera);
      let sequenceNumber: number | null = null;
      for (const response of responses) {
        const receipt = await response.getReceipt(hedera);
        if (receipt.topicSequenceNumber != null) {
          sequenceNumber = Number(receipt.topicSequenceNumber);
        }
      }
      if (sequenceNumber === null) throw new Error('HCS receipt has no sequence number');
      return { sequenceNumber };
    },
  };
}

export function assembleChunks(chunks: TopicMessage[]): string {
  const ordered = [...chunks].sort(
    (a, b) => (a.chunk_info?.number ?? 1) - (b.chunk_info?.number ?? 1),
  );
  return Buffer.concat(ordered.map((chunk) => Buffer.from(chunk.message, 'base64'))).toString('utf8');
}

function asSnapshot(text: string): Snapshot | null {
  try {
    const parsed = JSON.parse(text) as Partial<Snapshot>;
    return typeof parsed.epoch === 'number' && typeof parsed.inputsHash === 'string'
      ? (parsed as Snapshot)
      : null;
  } catch {
    return null;
  }
}

const MAX_PAGES = 10;

/** The topic, not the cache, is the record of what was published: it survives a wiped database. */
export async function readLatestSnapshot(
  mirror: MirrorClient,
  topicId: string,
  accept: (snapshot: Snapshot) => boolean = () => true,
): Promise<{ snapshot: Snapshot; sequenceNumber: number } | null> {
  const groups = new Map<string, TopicMessage[]>();
  let path: string | null = `/api/v1/topics/${topicId}/messages?limit=100&order=desc`;

  for (let page = 0; path && page < MAX_PAGES; page += 1) {
    const { messages, next } = await mirror.topicMessagesPage(path);
    for (const message of messages) {
      const start = message.chunk_info?.initial_transaction_id;
      const key = start
        ? `${start.account_id}-${start.transaction_valid_start}-${start.nonce}`
        : `seq-${message.sequence_number}`;
      const group = groups.get(key) ?? [];
      group.push(message);
      groups.set(key, group);

      if (group.length < (message.chunk_info?.total ?? 1)) continue;
      const snapshot = asSnapshot(assembleChunks(group));
      if (snapshot && accept(snapshot)) {
        const sequenceNumber = Math.max(...group.map((item) => item.sequence_number));
        return { snapshot, sequenceNumber };
      }
    }
    path = next;
  }
  return null;
}
