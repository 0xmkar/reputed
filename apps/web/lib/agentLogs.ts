import {
  REGISTERED,
  agentIdFromLogs as sharedAgentIdFromLogs,
  agentUriFromLog,
  serialFromLogs as sharedSerialFromLogs,
} from '@reputed/shared';
import type { TxLog } from './confirmTx';
import { CREATOR_REGISTRY } from './contracts';

export { REGISTERED, agentUriFromLog };

/**
 * The new agent's ID as a decimal string, or null if these logs hold none. IDs start at 0 on the live
 * registry, so check the result against null and never for truthiness.
 */
export const agentIdFromLogs = (logs: TxLog[]): string | null => sharedAgentIdFromLogs(logs);

/** The credential serial from this agent's AgentLinked log, or null if these logs hold none. */
export const serialFromLogs = (logs: TxLog[], agentId: string): number | null =>
  sharedSerialFromLogs(logs, CREATOR_REGISTRY, agentId);
