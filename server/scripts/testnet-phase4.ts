// Runs plan tests T4.1-T4.9 against Hedera testnet through the real server, then seeds what T5.1-T5.4
// need. The server must be running, and the Phase 3 script must have run (AGENT_X1 is its X1 agent).
// Usage: AGENT_X1=159 pnpm exec tsx --env-file=../.env scripts/testnet-phase4.ts
import { AccountId, Client, PrivateKey, TopicId, TopicMessageSubmitTransaction } from '@hashgraph/sdk';
import {
  createPublicClient, createWalletClient, defineChain, http, keccak256, stringToHex,
  type Abi, type Address, type Hash, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  HEDERA_TESTNET, IDENTITY_REGISTRY, REPUTATION_REGISTRY, creatorRegistryAbi, reputationRegistryAbi, serializeReviewFile,
  type ReviewFile, type ReviewFileResponse,
} from '@reputed/shared';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const api = process.env.API_URL ?? 'http://localhost:4000';
const agentId = BigInt(env('AGENT_X1'));
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
type Wallet = ReturnType<typeof wallet>;

const operator = wallet('OPERATOR');
const verifier = wallet('VERIFIER');
const c1 = wallet('TEST_CREATOR_1');
const c2 = wallet('TEST_CREATOR_2');
const c3 = wallet('TEST_CREATOR_3');
const u = wallet('WALLET_U');

async function mirrorJson(path: string): Promise<any> {
  for (let attempt = 0; attempt < 45; attempt++) {
    const res = await fetch(`${mirror}${path}`).catch(() => null);
    if (res?.ok) return res.json();
    await sleep(2000);
  }
  throw new Error(`no Mirror Node answer for ${path}`);
}
const outcome = async (hash: Hash) => {
  const r = await mirrorJson(`/api/v1/contracts/results/${hash}`);
  return { ok: r.status === '0x1', hash, gas: r.gas_used as number, logs: (r.logs ?? []) as { topics: Hex[] }[], error: r.error_message as string | null };
};
async function write(client: Wallet, address: Address, abi: Abi, functionName: string, args: unknown[], gas: bigint) {
  const gasPrice = await reader.getGasPrice();
  return outcome(await client.writeContract({ address, abi, functionName, args, gas, gasPrice, type: 'legacy' } as never));
}
async function pay(from: Wallet, to: Address, tinybars: bigint): Promise<Hash> {
  const gasPrice = await reader.getGasPrice();
  const hash = await from.sendTransaction({ to, value: tinybars * 10_000_000_000n, gas: 100_000n, gasPrice, type: 'legacy' } as never);
  const out = await outcome(hash);
  if (!out.ok) throw new Error(`payment failed: ${hash} ${out.error}`);
  await sleep(3000);
  return hash;
}

const results: string[] = [];
function check(id: string, pass: boolean, detail: string) {
  const line = `${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`;
  results.push(line);
  console.log(line);
}

interface ReviewInput { value: number; tag1: 'quality' | 'misconduct'; tag2: string; comment?: string; proof?: string }
async function postFile(client: Wallet, input: ReviewInput): Promise<ReviewFileResponse & { bytes: Uint8Array }> {
  const file: ReviewFile = {
    agentRegistry: `eip155:296:${IDENTITY_REGISTRY}`,
    agentId: agentId.toString(),
    clientAddress: `eip155:296:${client.account.address}`,
    createdAt: new Date().toISOString(),
    value: input.value, valueDecimals: 0, tag1: input.tag1, tag2: input.tag2,
    endpoint: 'https://example.com/agent',
    ...(input.comment ? { comment: input.comment } : {}),
    ...(input.proof ? { proofOfPayment: input.proof } : {}),
  };
  const bytes = serializeReviewFile(file);
  const signature = await client.signMessage({ message: { raw: bytes } });
  const res = await fetch(`${api}/api/review-file`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...file, signature }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`review-file ${res.status}: ${JSON.stringify(body)}`);
  return { ...(body as ReviewFileResponse), bytes };
}
async function review(client: Wallet, input: ReviewInput) {
  const posted = await postFile(client, input);
  const out = await write(client, REPUTATION_REGISTRY, reputationRegistryAbi as Abi, 'giveFeedback',
    [agentId, BigInt(input.value), 0, input.tag1, input.tag2, 'https://example.com/agent', posted.feedbackUri, posted.feedbackHash], 800_000n);
  await sleep(4000);
  return { ...posted, out };
}

async function ensureFunded(address: Address, hbar: bigint) {
  const want = hbar * 10n ** 18n;
  const have = await reader.getBalance({ address });
  if (have >= want) return;
  const gasPrice = await reader.getGasPrice();
  await outcome(await operator.sendTransaction({ to: address, value: want - have, gas: 800_000n, gasPrice, type: 'legacy' } as never));
  await sleep(3000);
}

async function main() {
  const agentWallet = await reader.readContract({
    address: IDENTITY_REGISTRY, abi: [{ type: 'function', name: 'getAgentWallet', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] }],
    functionName: 'getAgentWallet', args: [agentId],
  }) as Address;
  await ensureFunded(c3.account.address, 3n);
  if (!(await reader.readContract({ address: registry, abi: creatorRegistryAbi as Abi, functionName: 'isCreator', args: [c3.account.address] }))) {
    const nullifier = keccak256(stringToHex(`reputed-test-only:${c3.account.address}`));
    const r = await write(verifier, registry, creatorRegistryAbi as Abi, 'registerCreator', [nullifier, c3.account.address], 300_000n);
    if (!r.ok) throw new Error(`registerCreator: ${r.hash}`);
    await sleep(4000);
  }

  const paid = await pay(c2, agentWallet, 100_000_000n);
  check('T4.1', true, `1 HBAR to ${agentWallet}, ${paid}`);

  const first = await review(c2, { value: 90, tag1: 'quality', tag2: 'accuracy', comment: 'Testnet review', proof: paid });
  const [, , topic, seq] = /^(hcs):\/\/([\d.]+)\/(\d+)$/.exec(first.feedbackUri) ?? [];
  const msg = await mirrorJson(`/api/v1/topics/${topic}/messages/${seq}`);
  const onTopic = Buffer.from(msg.message, 'base64');
  check('T4.2', first.out.ok && keccak256(onTopic) === first.feedbackHash && Buffer.compare(onTopic, Buffer.from(first.bytes)) === 0,
    `${first.feedbackUri}, HCS bytes hash to feedbackHash, gas ${first.out.gas}, ${first.out.hash}`);

  const self = await write(c1, REPUTATION_REGISTRY, reputationRegistryAbi as Abi, 'giveFeedback',
    [agentId, 100n, 0, 'quality', 'accuracy', '', '', `0x${'00'.repeat(32)}`], 800_000n);
  check('T4.3', !self.ok, `owner review reverted, ${self.hash}`);

  const lastIndex = await reader.readContract({ address: REPUTATION_REGISTRY, abi: reputationRegistryAbi as Abi, functionName: 'getLastIndex', args: [agentId, c2.account.address] }) as bigint;
  const read = await reader.readContract({ address: REPUTATION_REGISTRY, abi: reputationRegistryAbi as Abi, functionName: 'readFeedback', args: [agentId, c2.account.address, lastIndex] }) as [bigint, number, string, string, boolean];
  check('T4.4', read[0] === 90n && read[2] === 'quality' && read[3] === 'accuracy', `readFeedback index ${lastIndex}: ${read[0]} ${read[2]}/${read[3]}`);

  const unbacked = await review(u, { value: 0, tag1: 'quality', tag2: 'accuracy', comment: 'No payment, not human-backed' });
  check('T4.5', unbacked.out.ok, `wallet U review landed, ${unbacked.out.hash}`);

  const madeUp = await review(c2, { value: 10, tag1: 'quality', tag2: 'accuracy', proof: '0.0.4441206@1700000000.000000001' });
  check('T4.6', madeUp.out.ok, `made-up payment review landed, ${madeUp.out.hash}`);

  const toRevoke = await review(c2, { value: 5, tag1: 'quality', tag2: 'uptime', comment: 'To be revoked' });
  const idx = await reader.readContract({ address: REPUTATION_REGISTRY, abi: reputationRegistryAbi as Abi, functionName: 'getLastIndex', args: [agentId, c2.account.address] }) as bigint;
  const revoked = await write(c2, REPUTATION_REGISTRY, reputationRegistryAbi as Abi, 'revokeFeedback', [agentId, idx], 300_000n);
  await sleep(4000);
  const all = await reader.readContract({ address: REPUTATION_REGISTRY, abi: reputationRegistryAbi as Abi, functionName: 'readAllFeedback', args: [agentId, [c2.account.address], '', '', false] }) as [Address[], bigint[], ...unknown[]];
  check('T4.7', toRevoke.out.ok && revoked.ok && !all[1].includes(idx), `index ${idx} revoked and left out, ${revoked.hash}`);

  const responded = await write(c1, REPUTATION_REGISTRY, reputationRegistryAbi as Abi, 'appendResponse',
    [agentId, c2.account.address, lastIndex, first.feedbackUri, first.feedbackHash], 400_000n);
  check('T4.8', responded.ok, `ResponseAppended, ${responded.hash}`);

  const uAccount = (await mirrorJson(`/api/v1/accounts/${u.account.address}`)).account as string;
  const client = Client.forTestnet().setOperator(AccountId.fromString(uAccount), PrivateKey.fromStringECDSA(env('WALLET_U_KEY').replace(/^0x/, '')));
  let refused = '';
  try {
    const tx = await new TopicMessageSubmitTransaction({ topicId: TopicId.fromString(env('REVIEWS_TOPIC_ID')), message: 'spam' }).execute(client);
    await tx.getReceipt(client);
  } catch (err) { refused = String((err as Error).message ?? err); }
  client.close();
  check('T4.9', /INVALID_SIGNATURE/.test(refused), `direct post from wallet U refused: ${refused.slice(0, 70)}`);

  const failed = results.filter((line) => line.startsWith('FAIL'));
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(String(err?.shortMessage ?? err?.message ?? err).slice(0, 400)); process.exit(2); });
