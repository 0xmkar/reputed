import type { Address } from '@reputed/shared';
import type { ConsensusTimestamp } from '../scoring/time.ts';
import type { OwnerPeriodStart, WalletPeriodStart } from '../scoring/types.ts';
import type { ChainEvent } from './decode.ts';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface AgentIdentity {
  agentId: string;
  owner: Address | null;
  ownerHistory: OwnerPeriodStart[];
  walletHistory: WalletPeriodStart[];
  agentUri: string;
  registeredAt: ConsensusTimestamp | null;
}

/** A wallet CreatorRegistry vouched for, through linkAgent or syncAgentWallet. */
export interface VouchedWallet {
  wallet: Address;
  serial: number;
  from: ConsensusTimestamp;
}

export interface AgentLink {
  agentId: string;
  creator: Address;
  /**
   * Who owned the agent NFT when it was linked: the creator for linkAgent, the agent's own account
   * for linkAgentWithGrant. The link only counts while the NFT stays with this address.
   */
  owner: Address;
  /** The API key's grant address when a grant did the link. */
  grantKey: Address | null;
  linkedAt: ConsensusTimestamp;
  /** The link-time wallet first, then each one synced after it. */
  wallets: VouchedWallet[];
}

/** CreatorRegistry.authorizeGrant: a key the creator lets link agents. */
export interface GrantRecord {
  grantKey: Address;
  creator: Address;
  /** Unix seconds. */
  expiresAt: number;
  maxAgents: number;
  authorizedAt: ConsensusTimestamp;
  revokedAt: ConsensusTimestamp | null;
}

export interface FeedbackEvent {
  agentId: string;
  client: Address;
  feedbackIndex: number;
  value: string;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackUri: string;
  feedbackHash: `0x${string}`;
  timestamp: ConsensusTimestamp;
  logIndex: number;
  txHash: string;
  revokedAt: ConsensusTimestamp | null;
}

export interface CredentialEvent {
  holder: Address;
  serial: number;
  issuedAt: ConsensusTimestamp;
  revokedAt: ConsensusTimestamp | null;
}

export interface ResponseEvent {
  responder: Address;
  uri: string;
  hash: `0x${string}`;
  timestamp: ConsensusTimestamp;
}

export interface ChainState {
  creators: Map<Address, { wallet: Address; registeredAt: ConsensusTimestamp }>;
  identities: Map<string, AgentIdentity>;
  links: Map<string, AgentLink>;
  grants: Map<Address, GrantRecord>;
  compromisedAt: Map<string, ConsensusTimestamp>;
  feedback: FeedbackEvent[];
  credentials: CredentialEvent[];
  /** By feedbackKey, in consensus order. Kept apart from feedback: replies never affect a score. */
  responses: Map<string, ResponseEvent[]>;
}

function identity(state: ChainState, agentId: string): AgentIdentity {
  let found = state.identities.get(agentId);
  if (!found) {
    found = {
      agentId,
      owner: null,
      ownerHistory: [],
      walletHistory: [],
      agentUri: '',
      registeredAt: null,
    };
    state.identities.set(agentId, found);
  }
  return found;
}

/** MetadataSet stores the wallet as 20 raw bytes, and as empty bytes when a transfer clears it. */
function walletFromMetadata(value: string): Address | null {
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? (value.toLowerCase() as Address) : null;
}

export const feedbackKey = (agentId: string, client: string, index: string | number) =>
  `${agentId}|${client}|${index}`;

/** Replays events in consensus order into state. Pure, so any event list gives the same answer. */
export function foldEvents(events: ChainEvent[]): ChainState {
  const state: ChainState = {
    creators: new Map(),
    identities: new Map(),
    links: new Map(),
    grants: new Map(),
    compromisedAt: new Map(),
    feedback: [],
    credentials: [],
    responses: new Map(),
  };
  const feedbackByKey = new Map<string, FeedbackEvent>();

  for (const event of events) {
    const { args, timestamp } = event;
    const str = (key: string) => String(args[key]);

    switch (event.name) {
      case 'Transfer': {
        const agent = identity(state, str('tokenId'));
        const owner = str('to') as Address;
        if (owner === ZERO_ADDRESS) break;
        agent.owner = owner;
        agent.ownerHistory.push({ owner, from: timestamp });
        break;
      }
      case 'Registered': {
        const agent = identity(state, str('agentId'));
        agent.agentUri = str('agentURI');
        agent.registeredAt = timestamp;
        break;
      }
      case 'URIUpdated':
        identity(state, str('agentId')).agentUri = str('newURI');
        break;
      case 'MetadataSet':
        if (args['metadataKey'] === 'agentWallet') {
          identity(state, str('agentId')).walletHistory.push({
            wallet: walletFromMetadata(str('metadataValue')),
            from: timestamp,
          });
        }
        break;
      case 'CreatorRegistered': {
        const wallet = str('wallet') as Address;
        if (!state.creators.has(wallet)) {
          state.creators.set(wallet, { wallet, registeredAt: timestamp });
        }
        break;
      }
      case 'AgentLinked': {
        const agentId = str('agentId');
        if (state.links.has(agentId)) break;
        state.links.set(agentId, {
          agentId,
          creator: str('creator') as Address,
          owner: str('creator') as Address,
          grantKey: null,
          linkedAt: timestamp,
          wallets: [
            {
              wallet: str('agentWallet') as Address,
              serial: Number(args['serial']),
              from: timestamp,
            },
          ],
        });
        break;
      }
      case 'AgentLinkedByGrant': {
        // Emitted right after AgentLinked in the same transaction.
        const link = state.links.get(str('agentId'));
        if (link && link.grantKey === null) {
          link.owner = str('owner') as Address;
          link.grantKey = str('grantKey') as Address;
        }
        break;
      }
      case 'GrantAuthorized': {
        const grantKey = str('grantKey') as Address;
        if (!state.grants.has(grantKey)) {
          state.grants.set(grantKey, {
            grantKey,
            creator: str('creator') as Address,
            expiresAt: Number(args['expiresAt']),
            maxAgents: Number(args['maxAgents']),
            authorizedAt: timestamp,
            revokedAt: null,
          });
        }
        break;
      }
      case 'GrantRevoked': {
        const grant = state.grants.get(str('grantKey') as Address);
        if (grant && grant.revokedAt === null) grant.revokedAt = timestamp;
        break;
      }
      case 'AgentWalletSynced':
        state.links.get(str('agentId'))?.wallets.push({
          wallet: str('agentWallet') as Address,
          serial: Number(args['serial']),
          from: timestamp,
        });
        break;
      case 'AgentCompromised': {
        const agentId = str('agentId');
        if (!state.compromisedAt.has(agentId)) state.compromisedAt.set(agentId, timestamp);
        break;
      }
      case 'CredentialIssued':
        state.credentials.push({
          holder: str('holder') as Address,
          serial: Number(args['serial']),
          issuedAt: timestamp,
          revokedAt: null,
        });
        break;
      case 'CredentialRevoked': {
        const serial = Number(args['serial']);
        const credential = state.credentials.find((item) => item.serial === serial);
        if (credential) credential.revokedAt = timestamp;
        break;
      }
      case 'NewFeedback': {
        const feedback: FeedbackEvent = {
          agentId: str('agentId'),
          client: str('clientAddress') as Address,
          feedbackIndex: Number(args['feedbackIndex']),
          value: str('value'),
          valueDecimals: Number(args['valueDecimals']),
          tag1: str('tag1'),
          tag2: str('tag2'),
          endpoint: str('endpoint'),
          feedbackUri: str('feedbackURI'),
          feedbackHash: str('feedbackHash') as `0x${string}`,
          timestamp,
          logIndex: event.logIndex,
          txHash: event.txHash,
          revokedAt: null,
        };
        state.feedback.push(feedback);
        feedbackByKey.set(
          feedbackKey(feedback.agentId, feedback.client, feedback.feedbackIndex),
          feedback,
        );
        break;
      }
      case 'FeedbackRevoked': {
        const key = feedbackKey(str('agentId'), str('clientAddress'), str('feedbackIndex'));
        const feedback = feedbackByKey.get(key);
        if (feedback) feedback.revokedAt = timestamp;
        break;
      }
      case 'ResponseAppended': {
        const key = feedbackKey(str('agentId'), str('clientAddress'), str('feedbackIndex'));
        const response: ResponseEvent = {
          responder: str('responder') as Address,
          uri: str('responseURI'),
          hash: str('responseHash') as `0x${string}`,
          timestamp,
        };
        const responses = state.responses.get(key);
        if (responses) responses.push(response);
        else state.responses.set(key, [response]);
        break;
      }
    }
  }
  return state;
}
