// Plan test T5.4 on Hedera testnet: two different creators pay an agent and report fraud through the
// real server. Run the Phase 3 and Phase 4 scripts first. The scorer must be running.
// Usage: AGENT_X1=159 pnpm exec tsx --env-file=../.env scripts/testnet-phase5.ts
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

async function agentJson(id: bigint | string): Promise<any> {
  return (await fetch(`${api}/api/agents/${id}`)).json();
}
const creatorJson = async (address: Address): Promise<any> => (await fetch(`${api}/api/creators/${address}`)).json();

async function main() {
  const before = await agentJson(agentId);
  const c1Before = await creatorJson(c1.account.address);
  const c2Before = await creatorJson(c2.account.address);
  const c3Before = await creatorJson(c3.account.address);
  console.log(`before: agent ${before.score.value}, creator ${c1Before.score}, others ${c2Before.score} and ${c3Before.score}`);

  for (const [name, reporter] of [['creator 2', c2], ['creator 3', c3]] as const) {
    const paid = await pay(reporter, before.wallet, 20_000_000n);
    const report = await review(reporter, { value: 0, tag1: 'misconduct', tag2: 'fraud', comment: 'Failed to deliver after payment', proof: paid });
    console.log(`${name} reported fraud: ${report.out.ok ? 'ok' : 'FAILED'}, ${report.out.hash}`);
  }

  let after: any;
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(5000);
    after = await agentJson(agentId);
    if (after.penaltiesConfirmed > 0) break;
  }
  const c1After = await creatorJson(c1.account.address);
  const c2After = await creatorJson(c2.account.address);
  const c3After = await creatorJson(c3.account.address);
  console.log(`after: agent ${after.score.value} ${after.score.tier}, penalties ${after.penaltiesConfirmed}, creator ${c1After.score}, P ${c1After.penaltyTotal}, others ${c2After.score} and ${c3After.score}`);
  console.log(JSON.stringify(c1After.penalties));
  check('T5.4', after.penaltiesConfirmed === 1 && after.score.value < before.score.value && c1After.score <= 80 && c1After.score < c1Before.score
    && c2After.score === c2Before.score && c3After.score === c3Before.score,
    `agent ${before.score.value} to ${after.score.value}, creator ${c1Before.score} to ${c1After.score}, other creators unchanged`);
  process.exit(results.some((line) => line.startsWith('FAIL')) ? 1 : 0);
}

main().catch((err) => { console.error(String(err?.shortMessage ?? err?.message ?? err).slice(0, 400)); process.exit(2); });
