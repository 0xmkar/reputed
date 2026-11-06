import { decodeEventLog, toEventSelector } from 'viem';
import { IDENTITY_REGISTRY, creatorRegistryAbi, identityRegistryAbi } from '@reputed/shared';
import type { TxLog } from './confirmTx';
import { CREATOR_REGISTRY } from './contracts';

export const REGISTERED = toEventSelector('Registered(uint256,string,address)');
const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;

const from = (log: TxLog, address: string) => log.address.toLowerCase() === address.toLowerCase();

/**
 * The new agent's ID as a decimal string, or null if these logs hold none. IDs start at 0 on the live
 * registry, so check the result against null and never for truthiness.
 */
export function agentIdFromLogs(logs: TxLog[]): string | null {
  const registry = logs.filter((log) => from(log, IDENTITY_REGISTRY));
  const registered = registry.find((log) => log.topics[0] === REGISTERED);
  const minted = registry.find((log) => log.topics[0] === TRANSFER && log.topics[1] === ZERO_TOPIC);
  const topic = registered ? registered.topics[1] : minted?.topics[3];
  return topic === undefined ? null : BigInt(topic).toString();
}

/** The credential serial from this agent's AgentLinked log, or null if these logs hold none. */
export function serialFromLogs(logs: TxLog[], agentId: string): number | null {
  for (const log of logs) {
    if (!from(log, CREATOR_REGISTRY)) continue;
    try {
      const event = decodeEventLog({ abi: creatorRegistryAbi, topics: log.topics as [], data: log.data });
      if (event.eventName === 'AgentLinked' && event.args.agentId === BigInt(agentId)) return Number(event.args.serial);
    } catch {
      // Not an event of this contract's ABI, so it cannot be AgentLinked.
    }
  }
  return null;
}

/** The agent URI from a Registered log, or null if the log cannot be decoded. */
export function agentUriFromLog(log: TxLog): string | null {
  try {
    const event = decodeEventLog({ abi: identityRegistryAbi, topics: log.topics as [], data: log.data });
    return event.eventName === 'Registered' ? event.args.agentURI : null;
  } catch {
    return null;
  }
}
