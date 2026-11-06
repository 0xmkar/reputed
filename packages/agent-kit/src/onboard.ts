import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import {
  GAS,
  agentIdFromLogs,
  agentUriFromLog,
  buildAgentFile,
  creatorRegistryAbi,
  grantAddress,
  hbarForGas,
  identityRegistryAbi,
  registerGas,
  registerWithUriAbi,
  serialFromLogs,
  signLinkGrant,
  type AgentFields,
  type AgentFileRequest,
  type AgentFileResponse,
  type ConfigResponse,
} from '@reputed/shared';
import { ReputedAgentError } from './errors';
import type { HederaGateway, TxOutcome } from './gateway';
import { CallReverted, type ContractResult, type MirrorClient } from './mirror';
import type { OnboardState, StateStore } from './state';

/** What the developer says about their agent. It becomes the ERC-8004 registration file. */
export interface AgentProfile {
  name: string;
  description?: string;
  /** An https:// or ipfs:// image URL. Not embedded data: the file is stored on-chain and has a size cap. */
  image?: string;
  tags?: string[];
  /** At least one is needed: ERC-8004 files list how to reach the agent. */
  endpoints: { a2a?: string; mcp?: string; web?: string };
  /** The price per call in HBAR, if the agent takes x402 payments. */
  x402PriceHbar?: number;
}

export type MirrorLike = Pick<
  MirrorClient,
  'getAccount' | 'getContractId' | 'call' | 'getContractResult' | 'registeredBy' | 'isAssociated'
>;

export interface OnboardDeps {
  gateway: HederaGateway;
  mirror: MirrorLike;
  config: ConfigResponse;
  apiKey: string;
  profile: AgentProfile;
  /** Use this agent instead of registering one. The account must own it. */
  agentId?: string;
  state: StateStore;
  postAgentFile(file: AgentFileRequest): Promise<AgentFileResponse>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export interface OnboardResult {
  agentId: string;
  /** The agent account's EVM address, which owns the agent NFT and holds the credential. */
  owner: Address;
  /** The verified human behind the API key. */
  creator: Address;
  /** The Human-backed credential serial, when this run saw the link happen. */
  serial: number | null;
  /** What this run did, in order. Empty when everything was already in place. */
  steps: string[];
}

interface Grant {
  creator: Address;
  expiresAt: bigint;
  maxAgents: number;
  used: number;
  revoked: boolean;
}

const RESULT_POLLS = 40;
const RESULT_GAP_MS = 1_500;
/** A registration whose transaction ID was never written down is given this long to show up. */
const UNKNOWN_SUBMIT_GRACE_MS = 60_000;
const DEADLINE_SECONDS = 600;
const HEADROOM_HBAR = 0.1;
const NOT_ASSOCIATED_CODES = new Set([184, 262]);

export function profileToFields(profile: AgentProfile): AgentFields {
  return {
    name: profile.name,
    description: profile.description ?? '',
    image: profile.image ?? '',
    tags: profile.tags ?? [],
    a2a: profile.endpoints.a2a ?? '',
    mcp: profile.endpoints.mcp ?? '',
    web: profile.endpoints.web ?? '',
    x402: profile.x402PriceHbar !== undefined,
    x402Price: profile.x402PriceHbar !== undefined ? String(profile.x402PriceHbar) : '',
  };
}

function nameInUri(uri: string | null): string | null {
  const prefix = 'data:application/json;base64,';
  if (!uri?.startsWith(prefix)) return null;
  try {
    const file = JSON.parse(Buffer.from(uri.slice(prefix.length), 'base64').toString('utf8')) as { name?: unknown };
    return typeof file.name === 'string' ? file.name : null;
  } catch {
    return null;
  }
}

export async function onboard(deps: OnboardDeps): Promise<OnboardResult> {
  const { gateway, mirror, config, apiKey, state: store } = deps;
  const steps: string[] = [];
  const say = (message: string) => {
    steps.push(message);
    deps.log(message);
  };

  if (!config.creatorRegistry) {
    throw new ReputedAgentError('NOT_CONFIGURED', 'The Reputed server has no CreatorRegistry configured yet, so agents cannot be linked.');
  }
  if (!config.credentialTokenId) {
    throw new ReputedAgentError('NOT_CONFIGURED', 'The Reputed server has no credential token configured yet.');
  }
  const creatorRegistry = getAddress(config.creatorRegistry);
  const identityRegistry = getAddress(config.identityRegistry);
  const credentialTokenId = config.credentialTokenId;
  const grantKey = grantAddress(apiKey);

  const account = await mirror.getAccount(gateway.accountId);
  if (!account?.evm_address) {
    throw new ReputedAgentError('MIRROR_ERROR', `The Mirror Node does not know account ${gateway.accountId} yet.`);
  }
  const owner = getAddress(account.evm_address);

  const stateKey = `${config.chainId}:${creatorRegistry.toLowerCase()}:${gateway.accountId}`;
  let state: OnboardState = store.load(stateKey);
  const save = (next: OnboardState) => {
    state = next;
    store.save(stateKey, state);
  };

  // Reads ------------------------------------------------------------------------------------

  async function readRegistry<T>(to: Address, abi: readonly unknown[], functionName: string, args: unknown[]): Promise<T> {
    const data = encodeFunctionData({ abi, functionName, args } as never);
    const out = await mirror.call(to, data);
    return decodeFunctionResult({ abi, functionName, data: out } as never) as T;
  }

  async function readGrant(): Promise<Grant> {
    const [creator, expiresAt, maxAgents, used, revoked] = await readRegistry<readonly [Address, bigint, number, number, boolean]>(
      creatorRegistry, creatorRegistryAbi, 'grants', [grantKey],
    );
    return { creator, expiresAt, maxAgents, used, revoked };
  }

  const creatorOf = async (agentId: string) =>
    getAddress(await readRegistry<Address>(creatorRegistry, creatorRegistryAbi, 'creatorOf', [BigInt(agentId)]));

  async function ownerOf(agentId: string): Promise<Address | null> {
    try {
      return getAddress(await readRegistry<Address>(identityRegistry, identityRegistryAbi, 'ownerOf', [BigInt(agentId)]));
    } catch (error) {
      if (error instanceof CallReverted) return null;
      throw error;
    }
  }

  function assertUsable(grant: Grant, forLinking: boolean): void {
    if (grant.creator === zeroAddress) {
      throw new ReputedAgentError(
        'GRANT_NOT_FOUND',
        'This API key has not been authorized on-chain. Create it from the dashboard and confirm the transaction, then try again.',
      );
    }
    if (!forLinking) return;
    if (grant.revoked) throw new ReputedAgentError('GRANT_REVOKED', 'This API key was revoked. Create a new one on the dashboard.');
    if (grant.expiresAt <= BigInt(Math.floor(deps.now() / 1000))) {
      throw new ReputedAgentError('GRANT_EXPIRED', 'This API key has expired. Create a new one on the dashboard.');
    }
    if (grant.used >= grant.maxAgents) {
      throw new ReputedAgentError('GRANT_EXHAUSTED', `This API key has already linked its ${grant.maxAgents} agent(s). Create a new one on the dashboard.`);
    }
  }

  // Sending ----------------------------------------------------------------------------------

  async function requireBalance(gas: bigint, what: string): Promise<void> {
    const fresh = await mirror.getAccount(gateway.accountId);
    const hbar = (fresh?.balance.balance ?? 0) / 1e8;
    const needed = hbarForGas(gas) + HEADROOM_HBAR;
    if (hbar < needed) {
      throw new ReputedAgentError(
        'INSUFFICIENT_HBAR',
        `Account ${gateway.accountId} has ${hbar.toFixed(2)} HBAR but needs about ${needed.toFixed(1)} HBAR to ${what}. Fund it (testnet faucet: https://portal.hedera.com/faucet) and run again.`,
      );
    }
  }

  async function waitForResult(tx: TxOutcome): Promise<ContractResult> {
    if (tx.status !== 'SUCCESS' && tx.status !== 'CONTRACT_REVERT_EXECUTED') {
      throw new ReputedAgentError('TRANSACTION_FAILED', `Hedera ended transaction ${tx.transactionId} with ${tx.status}.`, { transactionId: tx.transactionId });
    }
    for (let attempt = 0; attempt < RESULT_POLLS; attempt++) {
      const result = await mirror.getContractResult(tx.transactionId);
      if (result?.result) return result;
      await deps.sleep(RESULT_GAP_MS);
    }
    throw new ReputedAgentError('TIMEOUT', `Transaction ${tx.transactionId} was submitted but the Mirror Node has not reported its result. Run again to pick up where this left off.`, { transactionId: tx.transactionId });
  }

  function revertName(result: ContractResult): { name: string; args: readonly unknown[] } | null {
    if (!result.error_message || !result.error_message.startsWith('0x') || result.error_message.length < 10) return null;
    try {
      const decoded = decodeErrorResult({ abi: creatorRegistryAbi, data: result.error_message as Hex });
      return { name: decoded.errorName, args: (decoded.args ?? []) as readonly unknown[] };
    } catch {
      return null;
    }
  }

  // Associating ------------------------------------------------------------------------------

  async function associateCredentialToken(): Promise<void> {
    await requireBalance(GAS.associate, 'associate the credential token');
    say(`Associating account ${gateway.accountId} with the credential token ${credentialTokenId}`);
    const tx = await gateway.associateToken(credentialTokenId);
    if (tx.status !== 'SUCCESS' && tx.status !== 'TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT') {
      throw new ReputedAgentError('TRANSACTION_FAILED', `Could not associate the credential token: ${tx.status}.`, { transactionId: tx.transactionId });
    }
  }

  async function prepareAssociation(): Promise<void> {
    if (await mirror.isAssociated(gateway.accountId, credentialTokenId)) return;
    // Accounts with free automatic-association slots take the credential when it arrives.
    if (account!.max_automatic_token_associations !== 0) return;
    await associateCredentialToken();
  }

  // Step 1: the agent ------------------------------------------------------------------------

  async function findRegistered(uri?: string): Promise<string | null> {
    const logs = await mirror.registeredBy(identityRegistry, owner);
    for (const log of logs) {
      const found = agentUriFromLog(log);
      if (uri !== undefined ? found === uri : nameInUri(found) === deps.profile.name) return agentIdFromLogs([log], identityRegistry);
    }
    return null;
  }

  async function resolvePending(): Promise<string | null> {
    const pending = state.pendingRegistration;
    if (!pending) return null;

    if (pending.transactionId) {
      const result = await waitForResult({ transactionId: pending.transactionId, status: 'SUCCESS' });
      const agentId = result.result === 'SUCCESS' ? agentIdFromLogs(result.logs, identityRegistry) : null;
      if (agentId !== null) return agentId;
      say('The earlier registration did not go through; registering again');
      save({ ...state, pendingRegistration: undefined });
      return null;
    }

    // The process stopped between writing the URI down and learning the transaction ID. The URI
    // shows up in the registry's logs if the transaction was sent, so wait out the Mirror Node's lag.
    while (true) {
      const found = await findRegistered(pending.uri);
      if (found !== null) return found;
      if (deps.now() - pending.startedAt > UNKNOWN_SUBMIT_GRACE_MS) break;
      await deps.sleep(RESULT_GAP_MS);
    }
    save({ ...state, pendingRegistration: undefined });
    return null;
  }

  async function register(): Promise<string> {
    // A new agent will need linking, so a key that cannot link is refused now.
    assertUsable(grant, true);
    const { name } = deps.profile;
    if (!name.trim()) throw new ReputedAgentError('INVALID_ARGUMENT', 'The agent needs a name.');
    const file = buildAgentFile(profileToFields(deps.profile));
    const { uri } = await deps.postAgentFile(file);
    const gas = registerGas(uri.length);
    await requireBalance(gas, 'register the agent');

    // Written down before it is sent: a crash after the send must not register a second agent.
    save({ ...state, pendingRegistration: { uri, startedAt: deps.now() } });
    const identityContract = await mirror.getContractId(identityRegistry);
    if (!identityContract) throw new ReputedAgentError('MIRROR_ERROR', 'The Mirror Node does not know the Identity Registry.');

    say(`Registering "${name}" in the ERC-8004 Identity Registry`);
    const data = encodeFunctionData({ abi: registerWithUriAbi, functionName: 'register', args: [uri] });
    let tx: TxOutcome;
    try {
      tx = await gateway.executeContract(identityContract, data, gas);
    } catch (error) {
      // Rejected before consensus (no balance, bad signature): nothing was registered.
      save({ ...state, pendingRegistration: undefined });
      throw error;
    }
    save({ ...state, pendingRegistration: { uri, startedAt: state.pendingRegistration!.startedAt, transactionId: tx.transactionId } });

    const result = await waitForResult(tx);
    const agentId = result.result === 'SUCCESS' ? agentIdFromLogs(result.logs, identityRegistry) : null;
    if (agentId === null) {
      save({ ...state, pendingRegistration: undefined });
      throw new ReputedAgentError('TRANSACTION_FAILED', `Registering the agent failed (${result.result}).`, { transactionId: tx.transactionId });
    }
    return agentId;
  }

  async function resolveAgent(): Promise<string> {
    if (deps.agentId !== undefined) {
      const actual = await ownerOf(deps.agentId);
      if (actual !== owner) {
        throw new ReputedAgentError('OWNER_MISMATCH', `Agent ${deps.agentId} is not owned by account ${gateway.accountId} (${owner}).`);
      }
      return deps.agentId;
    }

    if (state.agentId !== undefined) {
      if ((await ownerOf(state.agentId)) === owner) return state.agentId;
      save({});
    }

    const resumed = await resolvePending();
    if (resumed !== null) return resumed;

    const existing = await findRegistered();
    if (existing !== null) {
      say(`Found agent #${existing}, already registered by this account`);
      return existing;
    }
    return register();
  }

  // A bad key is reported before anything is registered, so no gas is spent on an agent that cannot be linked.
  const grant = await readGrant();
  assertUsable(grant, false);

  const agentId = await resolveAgent();
  save({ ...state, agentId, pendingRegistration: undefined });

  // The Identity Registry and the Mirror Node can disagree about who owns the NFT: stop early.
  const actualOwner = await ownerOf(agentId);
  if (actualOwner !== owner) {
    throw new ReputedAgentError('OWNER_MISMATCH', `The Identity Registry says agent ${agentId} is owned by ${actualOwner ?? 'nobody'}, not ${owner}.`);
  }

  // Step 2: the link -------------------------------------------------------------------------

  async function sendLink(): Promise<{ result: ContractResult; transactionId: string }> {
    const deadline = BigInt(Math.floor(deps.now() / 1000) + DEADLINE_SECONDS);
    const signature = await signLinkGrant(apiKey, {
      creatorRegistry,
      agentId: BigInt(agentId),
      owner,
      deadline,
      chainId: config.chainId,
    });
    const data = encodeFunctionData({
      abi: creatorRegistryAbi,
      functionName: 'linkAgentWithGrant',
      args: [BigInt(agentId), grantKey, deadline, signature],
    });
    await requireBalance(GAS.linkAgentWithGrant, 'link the agent');
    const registryContract = await mirror.getContractId(creatorRegistry);
    if (!registryContract) throw new ReputedAgentError('MIRROR_ERROR', 'The Mirror Node does not know CreatorRegistry.');
    const tx = await gateway.executeContract(registryContract, data, GAS.linkAgentWithGrant);
    save({ ...state, pendingLink: { transactionId: tx.transactionId, startedAt: deps.now() } });
    return { result: await waitForResult(tx), transactionId: tx.transactionId };
  }

  let creator = await creatorOf(agentId);
  let serial: number | null = null;

  if (creator === zeroAddress) {
    assertUsable(grant, true);
    await prepareAssociation();
    say(`Linking agent #${agentId} to its creator ${grant.creator}`);

    let attempt = await sendLink();
    for (let retried = false; attempt.result.result !== 'SUCCESS'; retried = true) {
      const revert = revertName(attempt.result);
      const fail = (code: ConstructorParameters<typeof ReputedAgentError>[0], message: string) =>
        new ReputedAgentError(code, message, { transactionId: attempt.transactionId });

      switch (revert?.name) {
        case 'AlreadyLinked':
          creator = await creatorOf(agentId);
          break;
        case 'GrantNotFound':
          throw fail('GRANT_NOT_FOUND', 'The contract does not know this API key.');
        case 'GrantExpired':
          throw fail('GRANT_EXPIRED', 'This API key has expired. Create a new one on the dashboard.');
        case 'GrantIsRevoked':
          throw fail('GRANT_REVOKED', 'This API key was revoked. Create a new one on the dashboard.');
        case 'GrantExhausted':
          throw fail('GRANT_EXHAUSTED', 'This API key has already linked its maximum number of agents.');
        case 'NotAgentOwner':
          throw fail('OWNER_MISMATCH', `Account ${gateway.accountId} does not own agent ${agentId} on-chain.`);
        case 'HtsCallFailed': {
          const code = Number(revert.args[1]);
          if (NOT_ASSOCIATED_CODES.has(code) && !retried) {
            await associateCredentialToken();
            attempt = await sendLink();
            continue;
          }
          throw fail('TRANSACTION_FAILED', `The credential could not be delivered (Hedera response code ${code}).`);
        }
        default:
          throw fail('TRANSACTION_FAILED', `Linking failed: ${revert?.name ?? attempt.result.result}.`);
      }
      break;
    }

    if (creator === zeroAddress) {
      serial = serialFromLogs(attempt.result.logs, creatorRegistry, agentId);
      creator = await creatorOf(agentId);
    }
  }
  save({ ...state, pendingLink: undefined, ...(serial !== null ? { serial } : {}) });

  if (creator !== grant.creator) {
    throw new ReputedAgentError(
      'LINKED_TO_OTHER_CREATOR',
      `Agent ${agentId} is already linked to ${creator}, which is not the creator of this API key (${grant.creator}).`,
    );
  }

  return { agentId, owner, creator, serial: serial ?? state.serial ?? null, steps };
}
