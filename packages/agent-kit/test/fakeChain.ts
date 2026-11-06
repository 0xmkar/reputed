import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  recoverTypedDataAddress,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { creatorRegistryAbi, identityRegistryAbi, linkGrantTypedData, type AgentFileRequest } from '@reputed/shared';
import type { HederaGateway, TxOutcome } from '../src/gateway';
import { CallReverted, type ContractResult, type MirrorAccount } from '../src/mirror';
import type { MirrorLike } from '../src/onboard';

export const IDENTITY: Address = getAddress('0x8004A818BFB912233c491871b3d84c89A494BD9e');
export const REGISTRY: Address = getAddress('0x4444444444444444444444444444444444444444');
export const TOKEN = '0.0.700';
export const CREATOR: Address = getAddress('0x00000000000000000000000000000000000000aa');
export const OTHER_CREATOR: Address = getAddress('0x00000000000000000000000000000000000000bb');
export const ACCOUNT = '0.0.5000';
export const AGENT_EVM: Address = getAddress('0x5555555555555555555555555555555555555555');
const IDENTITY_CONTRACT = '0.0.1001';
const REGISTRY_CONTRACT = '0.0.1002';

interface GrantRow {
  creator: Address;
  expiresAt: bigint;
  maxAgents: number;
  used: number;
  revoked: boolean;
}

/**
 * An in-memory stand-in for the Identity Registry, CreatorRegistry and the Mirror Node, strict enough
 * to check what the SDK sends: the grant signature is recovered and compared, as the contract does.
 */
export class FakeChain implements MirrorLike, HederaGateway {
  readonly accountId = ACCOUNT;
  now = 1_800_000_000_000;

  hbar = 50;
  maxAutoAssociations = 0;
  /** Makes the first link fail the way a full set of auto-association slots does. */
  slotsExhausted = false;
  associated = new Set<string>();

  agents = new Map<string, { owner: Address; uri: string }>();
  linkedTo = new Map<string, Address>();
  grants = new Map<Address, GrantRow>();
  credentialSerial = 0;

  /** Every transaction the SDK sent, by what it was. */
  sent: string[] = [];
  results = new Map<string, ContractResult>();
  /** Throw on the nth `executeContract`, counting from 1. */
  failOnSend: number | null = null;
  private txCounter = 0;
  private contractSends = 0;

  readonly files: AgentFileRequest[] = [];

  addGrant(grantKey: Address, over: Partial<GrantRow> = {}): void {
    this.grants.set(getAddress(grantKey), {
      creator: CREATOR,
      expiresAt: BigInt(Math.floor(this.now / 1000) + 86_400),
      maxAgents: 5,
      used: 0,
      revoked: false,
      ...over,
    });
  }

  // MirrorLike ---------------------------------------------------------------------------------

  async getAccount(id: string): Promise<MirrorAccount | null> {
    if (id !== ACCOUNT) return null;
    return {
      account: ACCOUNT,
      evm_address: AGENT_EVM.toLowerCase(),
      balance: { balance: Math.round(this.hbar * 1e8) },
      max_automatic_token_associations: this.maxAutoAssociations,
    };
  }

  async getContractId(evm: string): Promise<string | null> {
    if (evm.toLowerCase() === IDENTITY.toLowerCase()) return IDENTITY_CONTRACT;
    if (evm.toLowerCase() === REGISTRY.toLowerCase()) return REGISTRY_CONTRACT;
    return null;
  }

  async call(to: Address, data: Hex): Promise<Hex> {
    if (to.toLowerCase() === REGISTRY.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: creatorRegistryAbi, data });
      if (functionName === 'grants') {
        const grant = this.grants.get(getAddress(args![0] as Address));
        return encodeFunctionResult({
          abi: creatorRegistryAbi,
          functionName: 'grants',
          result: grant
            ? [grant.creator, grant.expiresAt, grant.maxAgents, grant.used, grant.revoked]
            : [zeroAddress, 0n, 0, 0, false],
        });
      }
      if (functionName === 'creatorOf') {
        return encodeFunctionResult({
          abi: creatorRegistryAbi,
          functionName: 'creatorOf',
          result: this.linkedTo.get(String(args![0])) ?? zeroAddress,
        });
      }
    }
    if (to.toLowerCase() === IDENTITY.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: identityRegistryAbi, data });
      if (functionName === 'ownerOf') {
        const agent = this.agents.get(String(args![0]));
        if (!agent) throw new CallReverted(null);
        return encodeFunctionResult({ abi: identityRegistryAbi, functionName: 'ownerOf', result: agent.owner });
      }
    }
    throw new Error(`FakeChain.call: unhandled ${to} ${data.slice(0, 10)}`);
  }

  async getContractResult(transactionId: string): Promise<ContractResult | null> {
    return this.results.get(transactionId) ?? null;
  }

  async registeredBy(_identity: Address, owner: Address) {
    return [...this.agents.entries()]
      .filter(([, agent]) => agent.owner.toLowerCase() === owner.toLowerCase())
      .reverse()
      .map(([id, agent]) => this.registeredLog(id, agent.uri, agent.owner));
  }

  async isAssociated(_account: string, _token: string): Promise<boolean> {
    return this.associated.has(_account);
  }

  // HederaGateway ------------------------------------------------------------------------------

  async executeContract(contractId: string, data: Hex): Promise<TxOutcome> {
    this.txCounter++;
    this.contractSends++;
    if (this.failOnSend === this.contractSends) throw new Error('connection reset');
    const transactionId = `0.0.5000-${1_800_000_000 + this.txCounter}-000000000`;

    if (contractId === IDENTITY_CONTRACT) {
      const decoded = decodeFunctionData({ abi: [{ type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'agentURI', type: 'string' }], outputs: [{ type: 'uint256' }] }], data });
      const uri = decoded.args![0] as string;
      const id = String(this.agents.size);
      this.agents.set(id, { owner: AGENT_EVM, uri });
      this.sent.push('register');
      this.results.set(transactionId, { result: 'SUCCESS', error_message: null, logs: [this.registeredLog(id, uri, AGENT_EVM)] });
      return { transactionId, status: 'SUCCESS' };
    }

    if (contractId === REGISTRY_CONTRACT) {
      this.sent.push('link');
      const { args } = decodeFunctionData({ abi: creatorRegistryAbi, data });
      const [agentId, grantKey, deadline, signature] = args as [bigint, Address, bigint, Hex];
      const revert = (name: string, errorArgs: unknown[] = []) => {
        this.results.set(transactionId, {
          result: 'CONTRACT_REVERT_EXECUTED',
          error_message: encodeErrorResult({ abi: creatorRegistryAbi, errorName: name, args: errorArgs } as never),
          logs: [],
        });
        return { transactionId, status: 'CONTRACT_REVERT_EXECUTED' };
      };

      const grant = this.grants.get(getAddress(grantKey));
      if (!grant) return revert('GrantNotFound', [grantKey]);
      if (grant.revoked) return revert('GrantIsRevoked', [grantKey]);
      if (BigInt(Math.floor(this.now / 1000)) > grant.expiresAt) return revert('GrantExpired', [grantKey]);
      if (grant.used >= grant.maxAgents) return revert('GrantExhausted', [grantKey]);
      if (BigInt(Math.floor(this.now / 1000)) > deadline) return revert('GrantDeadlinePassed', [deadline]);
      if (this.linkedTo.has(String(agentId))) return revert('AlreadyLinked', [agentId]);

      const signer = await recoverTypedDataAddress({
        ...linkGrantTypedData({ creatorRegistry: REGISTRY, agentId, owner: AGENT_EVM, deadline }),
        signature,
      });
      if (signer.toLowerCase() !== grantKey.toLowerCase()) return revert('BadGrantSignature');
      if (this.agents.get(String(agentId))?.owner !== AGENT_EVM) return revert('NotAgentOwner', [agentId, AGENT_EVM]);

      const needsAssociation = !this.associated.has(ACCOUNT);
      if (needsAssociation && (this.maxAutoAssociations === 0 || this.slotsExhausted)) {
        return revert('HtsCallFailed', ['0x0debc2d3', this.slotsExhausted ? 262n : 184n]);
      }

      grant.used++;
      this.linkedTo.set(String(agentId), grant.creator);
      this.associated.add(ACCOUNT);
      const serial = ++this.credentialSerial;
      this.results.set(transactionId, {
        result: 'SUCCESS',
        error_message: null,
        logs: [
          {
            address: REGISTRY,
            topics: encodeEventTopics({
              abi: creatorRegistryAbi,
              eventName: 'AgentLinked',
              args: { agentId, creator: grant.creator, agentWallet: AGENT_EVM },
            }) as string[],
            data: encodeAbiParameters([{ type: 'int64' }], [BigInt(serial)]),
          },
        ],
      });
      return { transactionId, status: 'SUCCESS' };
    }
    throw new Error(`unknown contract ${contractId}`);
  }

  async associateToken(tokenId: string): Promise<TxOutcome> {
    this.txCounter++;
    if (tokenId !== TOKEN) throw new Error('wrong token');
    this.associated.add(ACCOUNT);
    this.slotsExhausted = false;
    this.sent.push('associate');
    return { transactionId: `0.0.5000-${1_800_000_000 + this.txCounter}-000000001`, status: 'SUCCESS' };
  }

  // helpers ------------------------------------------------------------------------------------

  private registeredLog(id: string, uri: string, owner: Address) {
    return {
      address: IDENTITY,
      topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: 'Registered', args: { agentId: BigInt(id), owner } }) as string[],
      data: encodeAbiParameters([{ type: 'string' }], [uri]),
    };
  }
}
