// Runs the whole flow on Hedera testnet: a test creator authorizes an API key, a funded agent account
// onboards itself with it, and the server is checked. Costs a few HBAR.
//   pnpm --filter @reputed/agent-kit exec tsx --env-file=../../.env scripts/testnet-e2e.ts
// Needs the server running (REPUTED_API_URL, default http://localhost:4000) and these in .env:
// TEST_CREATOR_1_KEY (a creator registered in the current CreatorRegistry), AGENT_B1_KEY (needs ~3 HBAR)
// and AGENT_A1_KEY (only used to show a revoked key is refused).
import { Client, PrivateKey } from '@hiero-ledger/sdk';
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HEDERA_TESTNET, creatorRegistryAbi, grantAddress, newApiKey } from '@reputed/shared';
import { MemoryStateStore, Reputed, ReputedAgentError } from '../src/index';

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const API = process.env['REPUTED_API_URL'] ?? 'http://localhost:4000';
const MIRROR = HEDERA_TESTNET.mirrorNode;
const REGISTRY = getAddress(need('CREATOR_REGISTRY'));
const hex = (key: string): Hex => (key.startsWith('0x') ? (key as Hex) : `0x${key}`);

const chain = defineChain({
  id: HEDERA_TESTNET.id,
  name: 'Hedera Testnet',
  nativeCurrency: HEDERA_TESTNET.nativeCurrency,
  rpcUrls: { default: { http: [HEDERA_TESTNET.rpcUrl] } },
});
const rpc = createPublicClient({ chain, transport: http() });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mirror = async <T>(path: string): Promise<T | null> => {
  const res = await fetch(`${MIRROR}/api/v1${path}`);
  return res.ok ? ((await res.json()) as T) : null;
};
const hbar = async (accountId: string) =>
  ((await mirror<{ balance: { balance: number } }>(`/accounts/${accountId}`))?.balance.balance ?? 0) / 1e8;

async function waitFor<T>(label: string, read: () => Promise<T | null | false>, tries = 40): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = await read();
    if (value) return value;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function sendAsCreator(functionName: 'authorizeGrant' | 'revokeGrant', args: unknown[], gas: bigint): Promise<void> {
  const account = privateKeyToAccount(hex(need('TEST_CREATOR_1_KEY')));
  const wallet = createWalletClient({ account, chain, transport: http() });
  const hash = await wallet.writeContract({ address: REGISTRY, abi: creatorRegistryAbi, functionName, args, gas } as never);
  const result = await waitFor(`${functionName} result`, () => mirror<{ result: string; error_message: string | null }>(`/contracts/results/${hash}`));
  if (result.result !== 'SUCCESS') throw new Error(`${functionName} failed: ${result.result} ${result.error_message}`);
  console.log(`  ${functionName}: ${hash}`);
}

async function agentClient(keyName: string): Promise<{ client: Client; accountId: string; evm: string }> {
  const key = PrivateKey.fromStringECDSA(need(keyName).replace(/^0x/, ''));
  const evm = privateKeyToAccount(hex(need(keyName))).address.toLowerCase();
  const account = await mirror<{ account: string }>(`/accounts/${evm}`);
  if (!account) throw new Error(`${keyName} has no account on testnet`);
  return { client: Client.forTestnet().setOperator(account.account, key), accountId: account.account, evm };
}

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
}

const creator = privateKeyToAccount(hex(need('TEST_CREATOR_1_KEY'))).address;
const isCreator = await rpc.readContract({ address: REGISTRY, abi: creatorRegistryAbi, functionName: 'isCreator', args: [creator] });
check('test creator is registered in the current CreatorRegistry', isCreator, creator);
if (!isCreator) process.exit(1);

console.log('\n1. Creator makes and authorizes an API key');
const apiKey = newApiKey('test');
const grant = grantAddress(apiKey);
await sendAsCreator('authorizeGrant', [grant, BigInt(Math.floor(Date.now() / 1000) + 3600), 2], 300_000n);
const stored = await rpc.readContract({ address: REGISTRY, abi: creatorRegistryAbi, functionName: 'grants', args: [grant] });
check('grant is on-chain with the right creator', stored[0].toLowerCase() === creator.toLowerCase() && stored[2] === 2, `maxAgents ${stored[2]}`);

console.log('\n2. A funded agent account onboards itself');
const a = await agentClient('AGENT_B1_KEY');
const progress = new MemoryStateStore(); // what the default .reputed/state.json does between runs
const before = await hbar(a.accountId);
const name = `E2E bot ${Date.now()}`;
const started = Date.now();
const first = await Reputed.connect({
  client: a.client,
  apiKey,
  apiUrl: API,
  agent: { name, description: 'End-to-end test agent', endpoints: { web: 'https://example.com/e2e' } },
  state: progress,
  logger: (message) => console.log(`  [reputed] ${message}`),
});
const spent = before - (await hbar(a.accountId));
check('first run registered and linked', first.onboarding.steps.length >= 2, `${Math.round((Date.now() - started) / 1000)}s, ${spent.toFixed(2)} HBAR spent, agent #${first.agentId}`);
check('creator is the key owner', first.creator.toLowerCase() === creator.toLowerCase());
check('credential serial returned', first.onboarding.serial !== null, String(first.onboarding.serial));

const owner = await rpc.readContract({ address: REGISTRY, abi: creatorRegistryAbi, functionName: 'linkedOwner', args: [BigInt(first.agentId)] });
check('linkedOwner equals the account Mirror reports as evm_address', owner.toLowerCase() === a.evm, owner);
const humanBacked = await rpc.readContract({ address: REGISTRY, abi: creatorRegistryAbi, functionName: 'isHumanBacked', args: [first.owner] });
check('CreatorRegistry.isHumanBacked(agent account)', humanBacked);

for (const result of (await mirror<{ results: { function_parameters: string; gas_used: number; gas_limit: number; to: string }[] }>(`/contracts/results?from=${a.evm}&limit=4&order=desc`))?.results ?? []) {
  console.log(`  tx to ${result.to}: gas used ${result.gas_used} of ${result.gas_limit}`);
}

console.log('\n3. Running again does nothing');
const second = await Reputed.connect({ client: a.client, apiKey, apiUrl: API, agent: { name, endpoints: { web: 'https://example.com/e2e' } }, state: progress });
check('second run reuses the agent and sends nothing', second.agentId === first.agentId && second.onboarding.steps.length === 0);

console.log('\n4. The server sees it');
const seen = await waitFor('the indexer to see the link', async () => {
  const body = (await (await fetch(`${API}/api/agents/${first.agentId}`)).json().catch(() => null)) as { humanBacked?: boolean; creator?: string; status?: string } | null;
  return body?.creator ? body : null;
}, 30);
check('API shows the agent human-backed, linked to the creator, active', seen.humanBacked === true && seen.creator?.toLowerCase() === creator.toLowerCase() && seen.status === 'active', JSON.stringify(seen).slice(0, 120));
const grants = (await (await fetch(`${API}/api/creators/${creator}/grants`)).json()) as { grants: { grantKey: string; used: number; agents: { agentId: string }[] }[] };
const row = grants.grants.find((g) => g.grantKey.toLowerCase() === grant.toLowerCase());
check('API lists the grant with the agent', row?.used === 1 && row.agents[0]?.agentId === first.agentId, JSON.stringify(row)?.slice(0, 100));
console.log('  reputation tool:', JSON.parse(await first.plugin.tools({}).find((t) => t.method === 'reputed_my_reputation')!.execute(a.client, {}, {})).humanMessage);

console.log('\n5. After the creator revokes the key, a new agent is refused');
await sendAsCreator('revokeGrant', [grant], 200_000n);
const b = await agentClient('AGENT_A1_KEY');
try {
  await Reputed.connect({ client: b.client, apiKey, apiUrl: API, agent: { name: `${name} b`, endpoints: { web: 'https://example.com/b' } }, state: false });
  check('revoked key is refused', false, 'connect succeeded');
} catch (error) {
  check('revoked key is refused before anything is registered', error instanceof ReputedAgentError && error.code === 'GRANT_REVOKED', String(error instanceof ReputedAgentError ? error.code : error));
}
console.log(`\nAgent #${first.agentId}: https://hashscan.io/testnet/token/${process.env['CREDENTIAL_TOKEN_ID']}/${first.onboarding.serial}`);

// The Hedera Client keeps its connections open, so end the process.
process.exit(process.exitCode ?? 0);
