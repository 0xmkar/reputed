import { Client, PrivateKey, TopicMessageSubmitTransaction } from '@hashgraph/sdk';
import type { Address } from 'viem';
import type { HederaConfig } from './config.ts';
import { createMirror, type Mirror } from './mirror.ts';

export function operatorEvmAddress(key: PrivateKey): Address {
  return `0x${key.publicKey.toEvmAddress()}`;
}

export class OperatorAccountMissing extends Error {
  override name = 'OperatorAccountMissing';
}

export async function resolveOperatorId(config: HederaConfig, mirror?: Mirror): Promise<string> {
  if (config.operatorId) return config.operatorId;

  const evmAddress = operatorEvmAddress(PrivateKey.fromStringECDSA(config.operatorKey));
  const id = await (mirror ?? createMirror(config.mirrorNode)).accountIdOf(evmAddress);
  if (!id) {
    throw new OperatorAccountMissing(
      `No Hedera account exists for ${evmAddress}. Fund it, or set OPERATOR_ID.`,
    );
  }
  return id;
}

export async function createOperatorClient(config: HederaConfig): Promise<Client> {
  const operatorId = await resolveOperatorId(config);
  return Client.forTestnet()
    .setOperator(operatorId, PrivateKey.fromStringECDSA(config.operatorKey))
    .setRequestTimeout(30_000);
}

export interface PublishedMessage {
  topicId: string;
  sequenceNumber: string;
}

export interface ReviewPublisher {
  publish(message: Uint8Array): Promise<PublishedMessage>;
}

export function buildTopicMessage(topicId: string, message: Uint8Array) {
  // maxChunks 1: a split file would no longer be one message anyone can hash.
  return new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(message)
    .setMaxChunks(1);
}

/**
 * The operator key is the topics' submit key, so the client's automatic
 * signature satisfies it. The client is built on first use: the server can then
 * start before the operator account exists and pick it up once funded.
 */
export function createReviewPublisher(config: HederaConfig, topicId: string): ReviewPublisher {
  let client: Promise<Client> | undefined;

  return {
    async publish(message) {
      client ??= createOperatorClient(config).catch((err) => {
        client = undefined;
        throw err;
      });
      const hedera = await client;

      const response = await buildTopicMessage(topicId, message).execute(hedera);
      const receipt = await response.getReceipt(hedera);
      if (receipt.topicSequenceNumber == null) {
        throw new Error('HCS receipt has no sequence number');
      }
      return { topicId, sequenceNumber: receipt.topicSequenceNumber.toString() };
    },
  };
}
