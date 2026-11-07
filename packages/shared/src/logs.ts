// Reading agent IDs, URIs and credential serials out of transaction logs. The same functions serve the
// web app (logs from the JSON-RPC relay) and the agent kit (logs from the Mirror Node), which is why
// TxLog is the lowest common shape and addresses are compared case-insensitively.
import { decodeEventLog, toEventSelector } from 'viem';
import { IDENTITY_REGISTRY } from './constants';
import { creatorRegistryAbi } from './abi/creatorRegistry';
import { identityRegistryAbi } from './abi/identityRegistry';

/** A contract log as the JSON-RPC relay and the Mirror Node return it. */
export interface TxLog {
  address: string;
  topics: readonly string[];
  data: string;
}

export const REGISTERED = toEventSelector('Registered(uint256,string,address)');
const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const ZERO_TOPIC = `0x${'0'.repeat(64)}`;

const from = (log: TxLog, address: string) => log.address.toLowerCase() === address.toLowerCase();

/**
 * The new agent's ID as a decimal string, or null if these logs hold none. IDs start at 0 on the live
 * registry, so check the result against null and never for truthiness.
 */
export function agentIdFromLogs(logs: readonly TxLog[], identityRegistry: string = IDENTITY_REGISTRY): string | null {
  const registry = logs.filter((log) => from(log, identityRegistry));
  const registered = registry.find((log) => log.topics[0] === REGISTERED);
  // Fallback: the ERC-721 mint (Transfer from the zero address) carries the same ID in its last topic.
  const minted = registry.find((log) => log.topics[0] === TRANSFER && log.topics[1] === ZERO_TOPIC);
  const topic = registered ? registered.topics[1] : minted?.topics[3];
  return topic === undefined ? null : BigInt(topic).toString();
}

/**
 * The credential serial from this agent's AgentLinked log, or null if these logs hold none. The agent
 * ID is checked so a transaction that touches several agents cannot hand back another one's serial.
 */
export function serialFromLogs(logs: readonly TxLog[], creatorRegistry: string, agentId: string): number | null {
  for (const log of logs) {
    if (!from(log, creatorRegistry)) continue;
    try {
      const event = decodeEventLog({ abi: creatorRegistryAbi, topics: log.topics as [], data: log.data as `0x${string}` });
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
    const event = decodeEventLog({ abi: identityRegistryAbi, topics: log.topics as [], data: log.data as `0x${string}` });
    return event.eventName === 'Registered' ? event.args.agentURI : null;
  } catch {
    return null;
  }
}
