import { creatorRegistryAbi, identityRegistryAbi, reputationRegistryAbi } from '@reputed/shared';
import { decodeEventLog, type Abi, type Hex } from 'viem';
import type { ConsensusTimestamp } from '../scoring/time.ts';

export type EventSource = 'identity' | 'reputation' | 'creatorRegistry';

export interface MirrorLog {
  address: string;
  data: string | null;
  index: number;
  topics: string[];
  timestamp: ConsensusTimestamp;
  transaction_hash: string;
}

export type EventArgs = Record<string, string | number | boolean>;

export interface ChainEvent {
  source: EventSource;
  name: string;
  args: EventArgs;
  timestamp: ConsensusTimestamp;
  logIndex: number;
  txHash: string;
}

function eventsNamed(abi: Abi, names: string[]): Abi {
  return abi.filter((item) => item.type === 'event' && names.includes(item.name));
}

const ABIS: Record<EventSource, Abi> = {
  identity: eventsNamed(identityRegistryAbi as Abi, [
    'Registered',
    'Transfer',
    'MetadataSet',
    'URIUpdated',
  ]),
  reputation: eventsNamed(reputationRegistryAbi as Abi, [
    'NewFeedback',
    'FeedbackRevoked',
    'ResponseAppended',
  ]),
  creatorRegistry: eventsNamed(creatorRegistryAbi as Abi, [
    'CreatorRegistered',
    'AgentLinked',
    'AgentWalletSynced',
    'AgentCompromised',
    'CredentialIssued',
    'CredentialRevoked',
  ]),
};

function plainArgs(args: Record<string, unknown>): EventArgs {
  const plain: EventArgs = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'bigint') plain[key] = value.toString();
    else if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) {
      plain[key] = value.toLowerCase();
    } else plain[key] = value as string | number | boolean;
  }
  return plain;
}

/** Null for events we do not index (Approval, MetadataUpdate, proxy admin) or cannot decode. */
export function decodeLog(source: EventSource, log: MirrorLog): ChainEvent | null {
  if (log.topics.length === 0) return null;
  try {
    const decoded = decodeEventLog({
      abi: ABIS[source],
      topics: log.topics as [Hex, ...Hex[]],
      data: (log.data ?? '0x') as Hex,
    }) as unknown as { eventName: string; args: Record<string, unknown> };
    return {
      source,
      name: decoded.eventName,
      args: plainArgs(decoded.args),
      timestamp: log.timestamp,
      logIndex: log.index,
      txHash: log.transaction_hash,
    };
  } catch {
    return null;
  }
}
