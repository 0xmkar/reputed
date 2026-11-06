// Runs plan tests T3.1-T3.5 and T3.7-T3.9 against Hedera testnet with real transactions.
// TEST_CREATOR_1 and TEST_CREATOR_2 are registered directly with the verifier key and a nullifier
// labelled test-only, so this does not involve World ID. Creators A, B and C stay clean for Phase 2.
// Usage: pnpm exec tsx --env-file=../.env scripts/testnet-phase3.ts
import {
  createPublicClient, createWalletClient, decodeEventLog, defineChain, http, keccak256, stringToHex, toHex,
  type Abi, type Address, type Hash, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HEDERA_TESTNET, IDENTITY_REGISTRY, creatorRegistryAbi, identityRegistryAbi } from '@reputed/shared';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const chain = defineChain({
  id: HEDERA_TESTNET.id, name: HEDERA_TESTNET.name, nativeCurrency: HEDERA_TESTNET.nativeCurrency,
  rpcUrls: { default: { http: [HEDERA_TESTNET.rpcUrl] } },
});
const transport = http(HEDERA_TESTNET.rpcUrl, { retryCount: 3, retryDelay: 2000, timeout: 60_000 });
const reader = createPublicClient({ chain, transport });
const registry = env('CREATOR_REGISTRY') as Address;
const mirror = HEDERA_TESTNET.mirrorNode;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const wallet = (name: string) => createWalletClient({ account: privateKeyToAccount(env(`${name}_KEY`) as Hex), chain, transport });
const verifier = wallet('VERIFIER');
const operator = wallet('OPERATOR');
const c1 = wallet('TEST_CREATOR_1');
const c2 = wallet('TEST_CREATOR_2');
const u = wallet('WALLET_U');
const agentWallet = wallet('AGENT_C1');

interface Outcome { ok: boolean; hash: Hash; gas: number; logs: { address: Address; topics: Hex[]; data: Hex }[]; error: string | null }

async function mirrorJson(path: string): Promise<any> {
  for (let attempt = 0; attempt < 45; attempt++) {
    const res = await fetch(`${mirror}${path}`).catch(() => null);
    if (res?.ok) return res.json();
    await sleep(2000);
  }
  throw new Error(`no Mirror Node answer for ${path}`);
}

async function outcome(hash: Hash): Promise<Outcome> {
  const r = await mirrorJson(`/api/v1/contracts/results/${hash}`);
  return { ok: r.status === '0x1', hash, gas: r.gas_used, logs: r.logs ?? [], error: r.error_message ?? null };
}

type Client = ReturnType<typeof wallet>;
async function write(client: Client, address: Address, abi: Abi, functionName: string, args: unknown[], gas: bigint): Promise<Outcome> {
  const gasPrice = await reader.getGasPrice();
  const hash = await client.writeContract({ address, abi, functionName, args, gas, gasPrice, type: 'legacy' } as never);
  return outcome(hash);
}

const results: string[] = [];
function check(id: string, pass: boolean, detail: string) {
  const line = `${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`;
  results.push(line);
  console.log(line);
}

const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[]) =>
  reader.readContract({ address, abi, functionName, args }) as Promise<T>;
const agentFile = (name: string) => `data:application/json;base64,${Buffer.from(JSON.stringify({
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name, description: `${name}, a Reputed testnet agent`, image: '',
  services: [{ name: 'web', endpoint: 'https://example.com/agent' }],
  x402Support: false, active: true, registrations: [], supportedTrust: ['reputation'],
})).toString('base64')}`;

async function register(client: Client, name: string): Promise<{ id: bigint; out: Outcome }> {
  const gasPrice = await reader.getGasPrice();
  const hash = await client.writeContract({
    address: IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: 'register', args: [agentFile(name)],
    gas: 1_500_000n, gasPrice, type: 'legacy',
  } as never);
  const out = await outcome(hash);
  if (!out.ok) throw new Error(`register failed: ${hash} ${out.error}`);
  for (const log of out.logs) {
    try {
      const event = decodeEventLog({ abi: identityRegistryAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (event.eventName === 'Registered') return { id: (event.args as { agentId: bigint }).agentId, out };
    } catch { /* another event */ }
  }
  throw new Error(`no Registered event in ${hash}`);
}

async function ensureCreator(client: Client) {
  const address = client.account.address;
  if (await read<boolean>(registry, creatorRegistryAbi as Abi, 'isCreator', [address])) return;
  const nullifier = keccak256(stringToHex(`reputed-test-only:${address}`));
  const out = await write(verifier, registry, creatorRegistryAbi as Abi, 'registerCreator', [nullifier, address], 300_000n);
  if (!out.ok) throw new Error(`registerCreator failed: ${out.hash} ${out.error}`);
  await sleep(4000);
}

async function fund(address: Address, hbar: bigint) {
  const have = await reader.getBalance({ address });
  const want = hbar * 10n ** 18n;
  if (have >= want) return;
  const gasPrice = await reader.getGasPrice();
  const hash = await operator.sendTransaction({ to: address, value: want - have, gas: 800_000n, gasPrice, type: 'legacy' } as never);
  await outcome(hash);
  await sleep(3000);
}

const link = (client: Client, id: bigint) => write(client, registry, creatorRegistryAbi as Abi, 'linkAgent', [id], 1_500_000n);
const creatorOf = (id: bigint) => read<Address>(registry, creatorRegistryAbi as Abi, 'creatorOf', [id]);
const walletOf = (id: bigint) => read<Address>(IDENTITY_REGISTRY, identityRegistryAbi as Abi, 'getAgentWallet', [id]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const zero = '0x0000000000000000000000000000000000000000';

async function main() {
  await fund(c1.account.address, 9n);
  await fund(c2.account.address, 6n);
  await ensureCreator(c1);
  await ensureCreator(c2);
  console.log(`creators ${c1.account.address} ${c2.account.address}`);

  const x1 = await register(c1, 'Reputed Test X1');
  await sleep(4000);
  const owner = await read<Address>(IDENTITY_REGISTRY, identityRegistryAbi as Abi, 'ownerOf', [x1.id]);
  const uri = await read<string>(IDENTITY_REGISTRY, identityRegistryAbi as Abi, 'tokenURI', [x1.id]);
  const parsed = JSON.parse(Buffer.from(uri.split(',')[1] ?? '', 'base64').toString());
  check('T3.1', same(owner, c1.account.address) && parsed.name === 'Reputed Test X1', `agent ${x1.id}, gas ${x1.out.gas}, ${x1.out.hash}`);

  const t32 = await link(u, x1.id);
  check('T3.2', !t32.ok, `linkAgent from wallet U reverted ${t32.error?.slice(0, 10)} ${t32.hash}`);
  const t33 = await link(c2, x1.id);
  check('T3.3', !t33.ok, `linkAgent by another creator reverted ${t33.error?.slice(0, 10)} ${t33.hash}`);

  const t34 = await link(c1, x1.id);
  await sleep(5000);
  const backed = await read<boolean>(registry, creatorRegistryAbi as Abi, 'isHumanBacked', [c1.account.address]);
  const acct = await mirrorJson(`/api/v1/accounts/${c1.account.address}`);
  const tok = await mirrorJson(`/api/v1/accounts/${acct.account}/tokens?token.id=${env('CREDENTIAL_TOKEN_ID')}`);
  const held = tok.tokens?.[0];
  check('T3.4', t34.ok && same(await creatorOf(x1.id), c1.account.address) && backed && held?.freeze_status === 'FROZEN' && Number(held?.balance) === 1,
    `gas ${t34.gas}, freeze ${held?.freeze_status}, balance ${held?.balance}, ${t34.hash}`);

  const t35 = await link(c1, x1.id);
  check('T3.5', !t35.ok, `second linkAgent reverted ${t35.error?.slice(0, 10)} ${t35.hash}`);

  const x2 = await register(c1, 'Reputed Test X2');
  await sleep(4000);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 240);
  const typed = {
    domain: { name: 'ERC8004IdentityRegistry', version: '1', chainId: 296, verifyingContract: IDENTITY_REGISTRY },
    types: { AgentWalletSet: [
      { name: 'agentId', type: 'uint256' }, { name: 'newWallet', type: 'address' },
      { name: 'owner', type: 'address' }, { name: 'deadline', type: 'uint256' },
    ] },
    primaryType: 'AgentWalletSet',
    message: { agentId: x2.id, newWallet: agentWallet.account.address, owner: c1.account.address, deadline },
  } as const;
  const badSig = await u.signTypedData(typed);
  const goodSig = await agentWallet.signTypedData(typed);
  const bad = await write(c1, IDENTITY_REGISTRY, identityRegistryAbi as Abi, 'setAgentWallet', [x2.id, agentWallet.account.address, deadline, badSig], 400_000n);
  const good = await write(c1, IDENTITY_REGISTRY, identityRegistryAbi as Abi, 'setAgentWallet', [x2.id, agentWallet.account.address, deadline, goodSig], 400_000n);
  await sleep(4000);
  check('T3.7', !bad.ok && good.ok && same(await walletOf(x2.id), agentWallet.account.address), `wrong signature reverted, valid one set the wallet, ${good.hash}`);

  const t37link = await link(c1, x2.id);
  await sleep(5000);
  const agentBacked = await read<boolean>(registry, creatorRegistryAbi as Abi, 'isHumanBacked', [agentWallet.account.address]);
  check('T3.4b', t37link.ok && agentBacked, `separate agent wallet is human-backed after link, gas ${t37link.gas}, ${t37link.hash}`);

  const x3 = await register(c1, 'Reputed Test X3');
  await sleep(4000);
  const x3link = await link(c1, x3.id);
  await sleep(4000);
  const moved = await write(c1, IDENTITY_REGISTRY, identityRegistryAbi as Abi, 'transferFrom', [c1.account.address, c2.account.address, x3.id], 400_000n);
  await sleep(5000);
  check('T3.8', x3link.ok && moved.ok && same(await creatorOf(x3.id), c1.account.address) && same(await walletOf(x3.id), zero),
    `creatorOf stays with the first creator and the agent wallet was cleared, ${moved.hash}`);

  const y1 = await register(c2, 'Reputed Test Y1');
  await sleep(4000);
  const y1link = await link(c2, y1.id);
  check('T3.9', y1link.ok, `agents ${x1.id}, ${x2.id}, ${x3.id} (creator 1), ${y1.id} (creator 2), ${y1link.hash}`);

  console.log(`\nagents: X1=${x1.id} X2=${x2.id} X3=${x3.id} Y1=${y1.id}`);
  const failed = results.filter((line) => line.startsWith('FAIL'));
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(String(err?.shortMessage ?? err?.message ?? err).slice(0, 300)); process.exit(2); });
