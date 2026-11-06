import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import rateLimit from '@fastify/rate-limit';
import { creatorRegistryAbi, identityRegistryAbi, reputationRegistryAbi, type Address } from '@reputed/shared';
import Fastify from 'fastify';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiItem, toEventSelector, toHex, type Abi, type AbiEvent, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { registerErrorHandling } from '../errors.ts';
import { DEFAULT_RATE_LIMITS, type RateLimits } from '../routes/rateLimits.ts';
import { SCORING_CONFIG } from '../scoring/config.ts';
import { registerReadRoutes } from '../scoring/routes.ts';
import { createEpochLoop } from '../scoring/scheduler.ts';
import { canonicalJson } from '../scoring/snapshot.ts';
import { toIso } from '../scoring/time.ts';
import { assembleChunks, readLatestSnapshot, type SnapshotPublisher } from '../scoring/topic.ts';
import { parseAgentProfile, loadAgentFile } from './agentFile.ts';
import { decodeLog, type MirrorLog } from './decode.ts';
import { foldEvents } from './fold.ts';
import { ingestSource } from './ingest.ts';
import { parseHcsUri } from './inputs.ts';
import { MirrorClient, MirrorError, toPaymentFact, type TopicMessage } from './mirror.ts';
import { ScorerRuntime, type RuntimeDeps } from './runtime.ts';
import type { ScorerSettings } from './settings.ts';
import { Store } from './store.ts';

const IDENTITY = '0x8004a818bfb912233c491871b3d84c89a494bd9e';
const REPUTATION = '0x8004b663056a597dffe9eccc1965a193b7388713';
const REGISTRY = '0x00000000000000000000000000000000000c0ffe';
const REVIEWS_TOPIC = '0.0.500';
const SCORES_TOPIC = '0.0.501';
const EPOCH = 3600;

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const CREATOR_A = addr(0xa);
const CREATOR_B = addr(0xb);
const WALLET_A1 = addr(0xa1);
const WALLET_B1 = addr(0xb1);
const WALLET_U = addr(0xee);
const account = (wallet: Address) => `0.0.${BigInt(wallet)}`;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** The body testnet Mirror answers a miss with, measured on 2026-11-06. */
const notFound = () => json({ _status: { messages: [{ message: 'Not found' }] } }, 404);
/** What a gateway in front of Mirror answered for a valid path, then 200 on the next try. */
const gatewayNotFound = () => new Response('404 page not found', { status: 404, headers: { 'content-type': 'text/plain' } });

let logIndex = 0;
function log(abi: Abi, eventName: string, args: Record<string, unknown>, timestamp: string, address: string): MirrorLog {
  const event = abi.find((item) => item.type === 'event' && item.name === eventName);
  if (event?.type !== 'event') throw new Error(eventName);
  const topics = encodeEventTopics({ abi: [event], eventName, args } as never) as Hex[];
  const unindexed = event.inputs.filter((input) => !input.indexed);
  const data = unindexed.length
    ? encodeAbiParameters(unindexed, unindexed.map((input) => args[input.name!]) as never)
    : '0x';
  logIndex += 1;
  return { address, data, index: logIndex, topics, timestamp, transaction_hash: `0x${logIndex.toString(16).padStart(64, '0')}` };
}

const identityLog = (name: string, args: Record<string, unknown>, ts: string) => log(identityRegistryAbi as Abi, name, args, ts, IDENTITY);
const reputationLog = (name: string, args: Record<string, unknown>, ts: string) => log(reputationRegistryAbi as Abi, name, args, ts, REPUTATION);
const registryLog = (name: string, args: Record<string, unknown>, ts: string) => log(creatorRegistryAbi as Abi, name, args, ts, REGISTRY);

const ts = (seconds: number) => `${seconds}.000000000`;
const BASE = 1_800_000_000 - (1_800_000_000 % EPOCH);

function agentUri(name: string): string {
  const body = JSON.stringify({
    name,
    description: 'trades things',
    image: 'https://example.com/a.png',
    tags: ['defi'],
    services: [{ name: 'A2A', endpoint: 'https://a2a.example' }, { name: 'MCP', endpoint: 'https://mcp.example' }],
    x402PriceHbar: 2,
  });
  return `data:application/json;base64,${Buffer.from(body).toString('base64')}`;
}

function mint(agentId: bigint, owner: Address, at: number, name: string): MirrorLog[] {
  return [
    identityLog('Transfer', { from: addr(0), to: owner, tokenId: agentId }, ts(at)),
    identityLog('Registered', { agentId, agentURI: agentUri(name), owner }, ts(at)),
    identityLog('MetadataSet', { agentId, indexedMetadataKey: 'agentWallet', metadataKey: 'agentWallet', metadataValue: owner }, ts(at)),
  ];
}

function setWallet(agentId: bigint, wallet: Hex, at: number): MirrorLog {
  return identityLog('MetadataSet', { agentId, indexedMetadataKey: 'agentWallet', metadataKey: 'agentWallet', metadataValue: wallet }, ts(at));
}

/** A stub of the Mirror Node's REST paths, serving a fixed chain. */
class FakeMirror {
  logs = new Map<string, MirrorLog[]>([[IDENTITY, []], [REPUTATION, []], [REGISTRY, []]]);
  messages = new Map<string, TopicMessage[]>([[REVIEWS_TOPIC, []], [SCORES_TOPIC, []]]);
  transactions = new Map<string, object[]>();
  accounts = new Map<string, { account: string; created_timestamp: string }>();
  consensus = ts(BASE + 10);
  calls: string[] = [];
  pageSize = 2;
  failing = false;
  /** Paths forced to answer with a status, as if Mirror were refusing that one lookup. */
  forced = new Map<string, number>();
  /** The first call matching this takes the whole mirror down. */
  outageOn: RegExp | null = null;
  /** How many more times each path answers with a gateway's 404 instead of Mirror's. */
  gatewayMisses = new Map<string, number>();
  private held: { path: RegExp; reached: () => void; release: Promise<void> } | null = null;

  /** Parks the next call matching path. Resolves once it arrives, with the function that frees it. */
  hold(path: RegExp): Promise<() => void> {
    let free = () => {};
    const release = new Promise<void>((resolve) => { free = resolve; });
    return new Promise((resolve) => {
      this.held = { path, release, reached: () => resolve(free) };
    });
  }

  fetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    this.calls.push(path + url.search);
    if (this.outageOn?.test(path)) this.failing = true;
    if (this.failing) return json({}, 503);
    if (this.held?.path.test(path)) {
      const { reached, release } = this.held;
      this.held = null;
      reached();
      await release;
    }
    const misses = this.gatewayMisses.get(path) ?? 0;
    if (misses > 0) {
      this.gatewayMisses.set(path, misses - 1);
      return gatewayNotFound();
    }
    const status = this.forced.get(path);
    if (status !== undefined) return json({}, status);

    if (path === '/api/v1/blocks') return json({ blocks: [{ timestamp: { to: this.consensus } }] });

    const logsMatch = /^\/api\/v1\/contracts\/([^/]+)\/results\/logs$/.exec(path);
    if (logsMatch) return this.logsPage(logsMatch[1]!, url);

    const single = /^\/api\/v1\/topics\/([^/]+)\/messages\/(\d+)$/.exec(path);
    if (single) {
      const sequence = BigInt(single[2]!);
      if (sequence === 0n || sequence >= 2n ** 63n) return json({}, 400);
      const found = this.messages.get(single[1]!)?.find((item) => item.sequence_number === Number(single[2]));
      return found ? json(found) : notFound();
    }
    const list = /^\/api\/v1\/topics\/([^/]+)\/messages$/.exec(path);
    if (list) return json({ messages: [...(this.messages.get(list[1]!) ?? [])].reverse(), links: { next: null } });

    const tx = /^\/api\/v1\/transactions\/([^/]+)$/.exec(path);
    if (tx) {
      // Measured on testnet: 400 past int64, 503 once valid start + 35 minutes overflows it in nanos.
      const seconds = BigInt(tx[1]!.split('-')[1]!);
      if (seconds >= 9223372037n) return json({}, 400);
      if (seconds >= 9223369937n) return json({}, 503);
      const found = this.transactions.get(tx[1]!);
      return found ? json({ transactions: found }) : notFound();
    }
    const acct = /^\/api\/v1\/accounts\/([^/]+)$/.exec(path);
    if (acct) {
      const found = this.accounts.get(acct[1]!);
      return found ? json(found) : notFound();
    }
    return notFound();
  };

  private logsPage(address: string, url: URL): Response {
    const from = url.searchParams.get('timestamp')?.replace('gte:', '') ?? '0';
    const after = Number(url.searchParams.get('after') ?? -1);
    const all = (this.logs.get(address.toLowerCase()) ?? []).filter((item) => item.timestamp >= from);
    const page = all.filter((_, index) => index > after).slice(0, this.pageSize);
    const last = after + page.length;
    const next = last < all.length - 1
      ? `/api/v1/contracts/${address}/results/logs?limit=100&order=asc&timestamp=gte:${from}&after=${last}`
      : null;
    return json({ logs: page, links: { next } });
  }

  addAccount(wallet: Address, created = ts(BASE - 1000)): void {
    this.accounts.set(wallet, { account: account(wallet), created_timestamp: created });
  }

  payment(from: Address, to: Address, at: number, id: string, result = 'SUCCESS'): void {
    this.transactions.set(id, [{
      transaction_id: id,
      consensus_timestamp: ts(at),
      result,
      transfers: [
        { account: account(from), amount: -100_001_000 },
        { account: account(to), amount: 100_000_000 },
        { account: '0.0.802', amount: 1000 },
      ],
      token_transfers: [],
    }]);
  }

  review(options: { agentId: bigint; client: Address; index: bigint; value: bigint; tag1?: string; tag2?: string; at: number; proof?: string }): void {
    const { agentId, client, index, value, tag1 = 'quality', tag2 = 'accuracy', at, proof } = options;
    const messages = this.messages.get(REVIEWS_TOPIC)!;
    const sequence = messages.length + 1;
    const bytes = Buffer.from(JSON.stringify({
      agentRegistry: `eip155:296:${IDENTITY}`,
      agentId: Number(agentId),
      clientAddress: `eip155:296:${client}`,
      value: Number(value),
      valueDecimals: 0,
      tag1,
      tag2,
      comment: `review ${sequence}`,
      ...(proof ? { proofOfPayment: proof } : {}),
    }));
    messages.push({ consensus_timestamp: ts(at - 1), message: bytes.toString('base64'), sequence_number: sequence });
    this.logs.get(REPUTATION)!.push(reputationLog('NewFeedback', {
      agentId,
      clientAddress: client,
      feedbackIndex: index,
      value,
      valueDecimals: 0,
      indexedTag1: tag1,
      tag1,
      tag2,
      endpoint: 'https://a2a.example',
      feedbackURI: `hcs://${REVIEWS_TOPIC}/${sequence}`,
      feedbackHash: keccak256(bytes),
    }, ts(at)));
  }
}

function seeded(): FakeMirror {
  const mirror = new FakeMirror();
  for (const wallet of [CREATOR_A, CREATOR_B, WALLET_A1, WALLET_B1, WALLET_U]) mirror.addAccount(wallet);
  mirror.logs.get(IDENTITY)!.push(
    ...mint(1n, CREATOR_A, BASE - 900, 'TradeBot A1'),
    setWallet(1n, WALLET_A1, BASE - 899),
    ...mint(2n, CREATOR_B, BASE - 880, 'Reviewer B1'),
    setWallet(2n, WALLET_B1, BASE - 879),
    ...mint(3n, WALLET_U, BASE - 870, 'Unlinked Bot'),
    ...mint(4n, CREATOR_A, BASE - 860, 'TradeBot A2'),
  );
  mirror.logs.get(REGISTRY)!.push(
    registryLog('CreatorRegistered', { nullifierHash: toHex(1, { size: 32 }), wallet: CREATOR_A }, ts(BASE - 950)),
    registryLog('CreatorRegistered', { nullifierHash: toHex(2, { size: 32 }), wallet: CREATOR_B }, ts(BASE - 940)),
    registryLog('CredentialIssued', { holder: WALLET_A1, serial: 1n }, ts(BASE - 850)),
    registryLog('AgentLinked', { agentId: 1n, creator: CREATOR_A, agentWallet: WALLET_A1, serial: 1n }, ts(BASE - 850)),
    registryLog('CredentialIssued', { holder: WALLET_B1, serial: 2n }, ts(BASE - 840)),
    registryLog('AgentLinked', { agentId: 2n, creator: CREATOR_B, agentWallet: WALLET_B1, serial: 2n }, ts(BASE - 840)),
    registryLog('CredentialIssued', { holder: CREATOR_A, serial: 3n }, ts(BASE - 830)),
    registryLog('AgentLinked', { agentId: 4n, creator: CREATOR_A, agentWallet: CREATOR_A, serial: 3n }, ts(BASE - 830)),
  );
  mirror.payment(WALLET_B1, WALLET_A1, BASE - 500, `${account(WALLET_B1)}-${BASE - 510}-000000001`);
  mirror.review({ agentId: 1n, client: WALLET_B1, index: 1n, value: 90n, at: BASE - 400, proof: `${account(WALLET_B1)}@${BASE - 510}.000000001` });
  mirror.review({ agentId: 1n, client: WALLET_U, index: 1n, value: 0n, at: BASE - 300 });
  mirror.review({ agentId: 1n, client: WALLET_B1, index: 2n, value: 5n, at: BASE - 200, proof: '0.0.999-1700000000-000000001' });
  return mirror;
}

const settings = (overrides: Partial<ScorerSettings> = {}): ScorerSettings => ({
  mirrorNode: 'https://mirror.test',
  identityRegistry: IDENTITY,
  reputationRegistry: REPUTATION,
  creatorRegistry: REGISTRY,
  reviewsTopicId: REVIEWS_TOPIC,
  scoresTopicId: SCORES_TOPIC,
  credentialTokenId: '0.0.700',
  dbPath: ':memory:',
  ipfsGateway: 'https://ipfs.example/ipfs/',
  epochSeconds: EPOCH,
  pollMs: 60_000,
  maxBackfillEpochs: 3,
  ...overrides,
});

function runtimeFor(fake: FakeMirror, store = new Store(':memory:'), overrides: Partial<ScorerSettings> = {}, epochSeconds = EPOCH, deps: Partial<RuntimeDeps> = {}): ScorerRuntime {
  return new ScorerRuntime({
    store,
    settings: settings(overrides),
    mirror: new MirrorClient({ baseUrl: 'https://mirror.test', fetch: fake.fetch, sleep: async () => {} }),
    config: { ...SCORING_CONFIG, epochSeconds },
    ...deps,
  });
}

interface ApiOptions {
  deps?: Partial<RuntimeDeps>;
  rateLimits?: Partial<RateLimits>;
  sync?: boolean;
  store?: Store;
}

async function api(fake = seeded(), options: ApiOptions = {}) {
  const runtime = runtimeFor(fake, options.store, {}, EPOCH, options.deps);
  if (options.sync !== false) await runtime.sync();
  const app = Fastify();
  registerErrorHandling(app);
  await app.register(rateLimit, { global: false });
  registerReadRoutes(app, runtime, { ...DEFAULT_RATE_LIMITS, ...options.rateLimits });
  await app.ready();
  const get = async (url: string, remoteAddress?: string) => {
    const response = await app.inject({ method: 'GET', url, ...(remoteAddress ? { remoteAddress } : {}) });
    return { status: response.statusCode, body: response.json(), headers: response.headers };
  };
  return { app, get, runtime };
}

function feedbackAt(uri: string, index: bigint, at: number, hash: Hex = toHex(0, { size: 32 })): MirrorLog {
  return reputationLog('NewFeedback', {
    agentId: 1n, clientAddress: WALLET_B1, feedbackIndex: index, value: 100n, valueDecimals: 0, indexedTag1: 'quality', tag1: 'quality', tag2: 'accuracy', endpoint: '',
    feedbackURI: uri, feedbackHash: hash,
  }, ts(at));
}

const paymentEntry = (name: string, at: number, id: string, transfers: object[]) => ({
  name, transaction_id: id, consensus_timestamp: ts(at), result: 'SUCCESS', transfers, token_transfers: [],
});
const feeOnly = [{ account: account(WALLET_B1), amount: -1000 }, { account: '0.0.802', amount: 1000 }];
const paidAgent = [{ account: account(WALLET_B1), amount: -100_001_000 }, { account: account(WALLET_A1), amount: 100_000_000 }, { account: '0.0.802', amount: 1000 }];

class RecordingPublisher implements SnapshotPublisher {
  published: string[] = [];
  failing = false;
  constructor(private readonly fake: FakeMirror) {}
  async publish(message: string) {
    if (this.failing) throw new Error('INSUFFICIENT_PAYER_BALANCE');
    this.published.push(message);
    const messages = this.fake.messages.get(SCORES_TOPIC)!;
    const sequence = messages.length + 1;
    messages.push({ consensus_timestamp: this.fake.consensus, message: Buffer.from(message).toString('base64'), sequence_number: sequence });
    return { sequenceNumber: sequence };
  }
}

const quietLog = { info: () => {}, error: () => {} };

/** The loop's own timer is stopped at once, so each test drives tick() by hand. */
async function loopFor(runtime: ScorerRuntime, publisher: SnapshotPublisher, log = quietLog) {
  const loop = createEpochLoop(runtime, publisher, log);
  await loop.stop();
  return loop;
}

describe('MirrorClient', () => {
  it('backs off exponentially on 429 and then succeeds', async () => {
    const delays: number[] = [];
    let calls = 0;
    const client = new MirrorClient({
      baseUrl: 'https://mirror.test',
      sleep: async (ms) => { delays.push(ms); },
      fetch: (async () => (++calls < 4 ? json({}, 429) : json({ ok: true }))) as typeof fetch,
    });
    await expect(client.getJson('/x')).resolves.toEqual({ ok: true });
    expect(delays).toEqual([500, 1000, 2000]);
  });
  it('honours Retry-After when it is longer', async () => {
    const delays: number[] = [];
    let calls = 0;
    const client = new MirrorClient({
      baseUrl: 'https://mirror.test',
      sleep: async (ms) => { delays.push(ms); },
      fetch: (async () => (++calls < 2 ? json({}, 429, { 'retry-after': '7' }) : json({}))) as typeof fetch,
    });
    await client.getJson('/x');
    expect(delays).toEqual([7000]);
  });
  it('gives up after the retry limit with a MirrorError', async () => {
    let calls = 0;
    const client = new MirrorClient({
      baseUrl: 'https://mirror.test',
      maxRetries: 2,
      sleep: async () => {},
      fetch: (async () => { calls += 1; return json({}, 429); }) as typeof fetch,
    });
    await expect(client.getJson('/x')).rejects.toBeInstanceOf(MirrorError);
    expect(calls).toBe(3);
  });
  it('retries network failures, returns null on 404, and does not retry a 400', async () => {
    let calls = 0;
    const flaky = new MirrorClient({
      baseUrl: 'https://mirror.test',
      sleep: async () => {},
      fetch: (async () => { if (++calls === 1) throw new TypeError('socket'); return notFound(); }) as typeof fetch,
    });
    await expect(flaky.getJson('/x')).resolves.toBeNull();
    expect(calls).toBe(2);

    calls = 0;
    const bad = new MirrorClient({
      baseUrl: 'https://mirror.test',
      sleep: async () => {},
      fetch: (async () => { calls += 1; return json({}, 400); }) as typeof fetch,
    });
    await expect(bad.getJson('/x')).rejects.toBeInstanceOf(MirrorError);
    expect(calls).toBe(1);
  });
  it('retries a 404 that did not come from Mirror, as it would a 5xx', async () => {
    let calls = 0;
    const client = new MirrorClient({
      baseUrl: 'https://mirror.test',
      sleep: async () => {},
      fetch: (async () => (++calls === 1 ? gatewayNotFound() : json({ ok: true }))) as typeof fetch,
    });
    await expect(client.getJson('/x')).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });
  it('gives up on a 404 that never comes from Mirror with a MirrorError, not a miss', async () => {
    for (const answer of [gatewayNotFound, () => json({}, 404), () => json({ _status: 'gone' }, 404), () => new Response('null', { status: 404 })]) {
      const client = new MirrorClient({ baseUrl: 'https://mirror.test', sleep: async () => {}, maxRetries: 2, fetch: (async () => answer()) as typeof fetch });
      await expect(client.getJson('/x')).rejects.toMatchObject({ name: 'MirrorError', status: 404 });
      await expect(client.topicMessage('0.0.500', 1)).rejects.toBeInstanceOf(MirrorError);
      await expect(client.account(WALLET_B1)).rejects.toBeInstanceOf(MirrorError);
      await expect(client.payment({ kind: 'transaction-id', key: '0.0.1-1-000000001' })).rejects.toBeInstanceOf(MirrorError);
      await expect(client.logsPage('/logs')).rejects.toBeInstanceOf(MirrorError);
    }
  });
  it('reads an EVM hash proof through contract results', async () => {
    const fake = new FakeMirror();
    const hash = `0x${'ab'.repeat(32)}`;
    const entry = { transaction_id: '0.0.5-1-000000002', consensus_timestamp: ts(9), result: 'SUCCESS', transfers: [] };
    const client = new MirrorClient({
      baseUrl: 'https://mirror.test',
      sleep: async () => {},
      fetch: (async (input: string) => {
        if (String(input).includes('/contracts/results/')) return json({ timestamp: ts(9) });
        if (String(input).includes('/transactions?timestamp=')) return json({ transactions: [entry] });
        return fake.fetch(input);
      }) as typeof fetch,
    });
    expect(toPaymentFact(await client.payment({ kind: 'eth-hash', key: hash }))).toMatchObject({ txId: '0.0.5-1-000000002' });
  });
  it('treats a 400 as not found on review lookups, and as an error everywhere else', async () => {
    const client = new MirrorClient({ baseUrl: 'https://mirror.test', sleep: async () => {}, fetch: (async () => json({}, 400)) as typeof fetch });
    await expect(client.topicMessage('0.0.500', 1)).resolves.toBeNull();
    await expect(client.payment({ kind: 'transaction-id', key: '0.0.1-1-000000001' })).resolves.toEqual([]);
    await expect(client.payment({ kind: 'eth-hash', key: `0x${'ab'.repeat(32)}` })).resolves.toEqual([]);
    await expect(client.account(WALLET_B1)).resolves.toBeNull();
    await expect(client.logsPage('/logs')).rejects.toBeInstanceOf(MirrorError);
    await expect(client.latestConsensusTimestamp()).rejects.toBeInstanceOf(MirrorError);
  });
  it('still throws on a 5xx from a review lookup', async () => {
    const client = new MirrorClient({ baseUrl: 'https://mirror.test', sleep: async () => {}, maxRetries: 1, fetch: (async () => json({}, 503)) as typeof fetch });
    await expect(client.topicMessage('0.0.500', 1)).rejects.toBeInstanceOf(MirrorError);
  });
});

describe('parseHcsUri', () => {
  it('reads a topic and sequence', () => {
    expect(parseHcsUri('hcs://0.0.500/7')).toEqual({ topicId: '0.0.500', sequence: 7 });
  });
  it('rejects sequences Mirror cannot answer, or that a number cannot hold', () => {
    for (const sequence of ['0', '000', '9223372036854775807', '9223372036854775808', '100000000000000000000']) {
      expect(parseHcsUri(`hcs://0.0.500/${sequence}`)).toBeNull();
    }
  });
});

describe('toPaymentFact', () => {
  const tx = (result: string, at: number, amount: number) => ({
    transaction_id: '0.0.1-5-000000006',
    consensus_timestamp: ts(at),
    result,
    transfers: [{ account: '0.0.2', amount }],
  });
  it('merges successful entries and ignores failed ones', () => {
    const fact = toPaymentFact([tx('SUCCESS', 10, 5), tx('REVERTED_SUCCESS', 11, 99), tx('SUCCESS', 12, 7)]);
    expect(fact).toMatchObject({ result: 'SUCCESS', consensusTimestamp: ts(12) });
    expect(fact!.transfers.map((item) => item.amount)).toEqual(['5', '7']);
  });
  it('keeps the failure when nothing succeeded', () => {
    expect(toPaymentFact([tx('INSUFFICIENT_ACCOUNT_BALANCE', 10, 5)])).toMatchObject({ result: 'INSUFFICIENT_ACCOUNT_BALANCE', transfers: [] });
    expect(toPaymentFact([])).toBeNull();
  });
});

describe('decodeLog', () => {
  it('decodes NewFeedback, FeedbackRevoked and ResponseAppended', () => {
    const fake = new FakeMirror();
    fake.review({ agentId: 7n, client: WALLET_B1, index: 3n, value: 88n, at: BASE });
    const decoded = decodeLog('reputation', fake.logs.get(REPUTATION)![0]!);
    expect(decoded).toMatchObject({ name: 'NewFeedback', args: { agentId: '7', clientAddress: WALLET_B1, feedbackIndex: '3', value: '88', valueDecimals: 0, tag1: 'quality', tag2: 'accuracy' } });
    expect(decodeLog('reputation', reputationLog('FeedbackRevoked', { agentId: 7n, clientAddress: WALLET_B1, feedbackIndex: 3n }, ts(BASE)))?.name).toBe('FeedbackRevoked');
    expect(decodeLog('reputation', reputationLog('ResponseAppended', { agentId: 7n, clientAddress: WALLET_B1, feedbackIndex: 3n, responder: CREATOR_A, responseURI: 'x', responseHash: toHex(1, { size: 32 }) }, ts(BASE)))?.name).toBe('ResponseAppended');
  });
  it('decodes negative int128 values', () => {
    const raw = reputationLog('NewFeedback', { agentId: 1n, clientAddress: WALLET_B1, feedbackIndex: 1n, value: -5n, valueDecimals: 0, indexedTag1: 'q', tag1: 'q', tag2: '', endpoint: '', feedbackURI: '', feedbackHash: toHex(0, { size: 32 }) }, ts(BASE));
    expect(decodeLog('reputation', raw)?.args['value']).toBe('-5');
  });
  it('decodes the CreatorRegistry events', () => {
    const decoded = decodeLog('creatorRegistry', registryLog('AgentLinked', { agentId: 9n, creator: CREATOR_A, agentWallet: WALLET_A1, serial: 4n }, ts(BASE)));
    expect(decoded).toMatchObject({ name: 'AgentLinked', args: { agentId: '9', creator: CREATOR_A, agentWallet: WALLET_A1, serial: '4' } });
    expect(decodeLog('creatorRegistry', registryLog('AgentCompromised', { agentId: 9n, creator: CREATOR_A, timestamp: 5n }, ts(BASE)))?.name).toBe('AgentCompromised');
  });
  it('decodes AgentWalletSynced', () => {
    const decoded = decodeLog('creatorRegistry', registryLog('AgentWalletSynced', { agentId: 0n, creator: CREATOR_A, agentWallet: WALLET_U, serial: 9n }, ts(BASE)));
    expect(decoded).toMatchObject({ name: 'AgentWalletSynced', args: { agentId: '0', creator: CREATOR_A, agentWallet: WALLET_U, serial: '9' } });
  });
  // Pinned to the agreed interface, so a contract change that renames or reorders an event fails here.
  it.each([
    'event CreatorRegistered(bytes32 indexed nullifierHash, address indexed wallet)',
    'event AgentLinked(uint256 indexed agentId, address indexed creator, address indexed agentWallet, int64 serial)',
    'event AgentWalletSynced(uint256 indexed agentId, address indexed creator, address indexed agentWallet, int64 serial)',
    'event AgentCompromised(uint256 indexed agentId, address indexed creator, uint256 timestamp)',
    'event CredentialIssued(address indexed holder, int64 serial)',
    'event CredentialRevoked(address indexed holder, int64 serial)',
  ] as const)('matches the compiled ABI: %s', (signature) => {
    const expected = parseAbiItem(signature as string) as AbiEvent;
    const actual = creatorRegistryAbi.find((item) => item.type === 'event' && item.name === expected.name) as AbiEvent;
    expect(toEventSelector(actual)).toBe(toEventSelector(expected));
    expect(actual.inputs.map(({ name, indexed }) => ({ name, indexed: indexed ?? false }))).toEqual(
      expected.inputs.map(({ name, indexed }) => ({ name, indexed: indexed ?? false })),
    );
  });
  it('skips registry events the scorer does not use', () => {
    const grant = log(creatorRegistryAbi as Abi, 'RoleGranted', { role: toHex(0, { size: 32 }), account: CREATOR_A, sender: CREATOR_A }, ts(BASE), REGISTRY);
    expect(decodeLog('creatorRegistry', grant)).toBeNull();
  });
  it('skips logs it does not index', () => {
    const approval = log(identityRegistryAbi as Abi, 'Approval', { owner: CREATOR_A, approved: CREATOR_B, tokenId: 1n }, ts(BASE), IDENTITY);
    expect(decodeLog('identity', approval)).toBeNull();
    expect(decodeLog('identity', { ...approval, topics: [] })).toBeNull();
  });
});

describe('foldEvents', () => {
  const decodeAll = (logs: MirrorLog[]) => logs.flatMap((item) => decodeLog('identity', item) ?? []);
  it('tracks wallet history, including the clear on transfer', () => {
    const state = foldEvents(decodeAll([
      ...mint(1n, CREATOR_A, BASE, 'x'),
      setWallet(1n, '0x', BASE + 1),
      identityLog('Transfer', { from: CREATOR_A, to: CREATOR_B, tokenId: 1n }, ts(BASE + 1)),
    ]));
    const agent = state.identities.get('1')!;
    expect(agent.owner).toBe(CREATOR_B);
    expect(agent.walletHistory.map((item) => item.wallet)).toEqual([CREATOR_A, null]);
  });
  it('applies URI updates', () => {
    const state = foldEvents(decodeAll([...mint(1n, CREATOR_A, BASE, 'x'), identityLog('URIUpdated', { agentId: 1n, newURI: 'ipfs://new', updatedBy: CREATOR_A }, ts(BASE + 1))]));
    expect(state.identities.get('1')!.agentUri).toBe('ipfs://new');
  });
});

describe('ingest', () => {
  it('follows links.next through every page', async () => {
    const fake = seeded();
    const runtime = runtimeFor(fake);
    const added = await ingestSource(runtime.store, runtime.mirror, { source: 'identity', address: IDENTITY });
    expect(added).toBe(fake.logs.get(IDENTITY)!.length);
    expect(fake.calls.length).toBeGreaterThan(3);
  });
  it('resumes from the saved timestamp and stores nothing twice', async () => {
    const fake = seeded();
    const runtime = runtimeFor(fake);
    const source = { source: 'identity', address: IDENTITY } as const;
    await ingestSource(runtime.store, runtime.mirror, source);
    const cursor = runtime.store.cursor('identity');
    expect(cursor).toBe(fake.logs.get(IDENTITY)!.at(-1)!.timestamp);

    fake.calls = [];
    await expect(ingestSource(runtime.store, runtime.mirror, source)).resolves.toBe(0);
    expect(fake.calls[0]).toContain(`timestamp=gte:${cursor}`);
  });
  it('keeps the progress of finished pages when a later page fails', async () => {
    const fake = seeded();
    const runtime = runtimeFor(fake);
    let pages = 0;
    const realFetch = fake.fetch;
    const client = new MirrorClient({
      baseUrl: 'https://mirror.test',
      maxRetries: 0,
      sleep: async () => {},
      fetch: ((input: string) => (++pages > 2 ? Promise.resolve(json({}, 503)) : realFetch(input))) as typeof fetch,
    });
    await expect(ingestSource(runtime.store, client, { source: 'identity', address: IDENTITY })).rejects.toBeInstanceOf(MirrorError);
    const saved = runtime.store.cursor('identity');
    expect(saved).toBe(fake.logs.get(IDENTITY)![3]!.timestamp);
    await ingestSource(runtime.store, runtime.mirror, { source: 'identity', address: IDENTITY });
    expect(runtime.store.eventsUpTo(ts(BASE + 10)).filter((item) => item.source === 'identity')).toHaveLength(fake.logs.get(IDENTITY)!.length);
  });
});

describe('sync and scoring from logs', () => {
  it('reaches T5.1-T5.3 from raw logs: 90, with both bad reviews excluded for the right reason', async () => {
    const runtime = runtimeFor(seeded());
    await runtime.sync();
    const { result } = runtime.view()!;
    expect(result.agents.find((item) => item.agentId === '1')).toMatchObject({ score: 90, tier: 'Tier 1', counted: 1, excluded: 2 });
    expect(result.reviews.map((item) => item.exclusionReason)).toEqual([undefined, 'not-human-backed', 'payment-not-found']);
  });
  it('does not fetch files or payments for agents nobody linked or asked for', async () => {
    const fake = seeded();
    fake.review({ agentId: 3n, client: WALLET_B1, index: 9n, value: 50n, at: BASE - 100 });
    const reviewMessages = fake.messages.get(REVIEWS_TOPIC)!.length;
    await runtimeFor(fake).sync();
    const fetched = fake.calls.filter((call) => /\/topics\/.+\/messages\/\d+/.test(call));
    expect(fetched).toHaveLength(reviewMessages - 1);
  });
  it('fetches each fact once across ticks', async () => {
    const fake = seeded();
    const runtime = runtimeFor(fake);
    await runtime.sync();
    fake.calls = [];
    await runtime.sync();
    expect(fake.calls.filter((call) => /\/(topics|transactions|accounts)\//.test(call))).toEqual([]);
  });
  it('keeps the last view when the mirror is down, rather than calling payments missing', async () => {
    const fake = seeded();
    const runtime = runtimeFor(fake);
    await runtime.sync();
    const before = runtime.view();
    fake.failing = true;
    await expect(runtime.sync()).rejects.toBeInstanceOf(MirrorError);
    expect(runtime.view()).toBe(before);
  });
  it('holds an epoch back while a fact could not be fetched', async () => {
    const fake = seeded();
    const runtime = runtimeFor(fake);
    await runtime.sync();
    fake.review({ agentId: 1n, client: WALLET_B1, index: 3n, value: 70n, at: BASE - 100, proof: '0.0.77-1700000000-000000002' });
    await ingestSource(runtime.store, runtime.mirror, { source: 'reputation', address: REPUTATION });
    expect(runtime.buildEpoch(BASE / EPOCH).pending).toBe(1);
  });
  it('treats a revocation after the epoch as not yet revoked', async () => {
    const fake = seeded();
    fake.logs.get(REPUTATION)!.push(reputationLog('FeedbackRevoked', { agentId: 1n, clientAddress: WALLET_B1, feedbackIndex: 1n }, ts(BASE + 5)));
    const runtime = runtimeFor(fake);
    await runtime.sync();
    expect(runtime.buildEpoch(BASE / EPOCH).snapshot.agents.find((item) => item.agentId === '1')!.counted).toBe(1);
    expect(runtime.view()!.result.reviews[0]!.exclusionReason).toBe('revoked');
  });
  it('excludes reviews citing sequences Mirror rejects, and keeps every other review scoring', async () => {
    const fake = seeded();
    for (const [index, sequence] of ['0', '100000000000000000000', '9223372036854775807'].entries()) {
      fake.logs.get(REPUTATION)!.push(feedbackAt(`hcs://${REVIEWS_TOPIC}/${sequence}`, BigInt(20 + index), BASE - 50 + index));
    }
    const runtime = runtimeFor(fake);
    await runtime.sync();
    const { result } = runtime.view()!;
    expect(result.reviews.slice(-3).map((item) => item.exclusionReason)).toEqual(['hash-mismatch', 'hash-mismatch', 'hash-mismatch']);
    expect(result.agents.find((item) => item.agentId === '1')).toMatchObject({ score: 90, counted: 1 });
    expect(runtime.buildEpoch(BASE / EPOCH).pending).toBe(0);
  });
  it('excludes a review citing an ID Mirror rejects, without asking for it', async () => {
    const fake = seeded();
    const bad = ['0.0.1-9999999999999999999-1', '0.0.1-9223372036-1', '0.0.0-1700000000-1'];
    bad.forEach((proof, index) => fake.review({ agentId: 1n, client: WALLET_B1, index: BigInt(20 + index), value: 100n, at: BASE - 50 + index, proof }));
    const runtime = runtimeFor(fake);
    await runtime.sync();
    expect(runtime.view()!.result.reviews.slice(-3).map((item) => item.exclusionReason)).toEqual(['payment-not-found', 'payment-not-found', 'payment-not-found']);
    expect(fake.calls.filter((call) => /\/transactions\/0\.0\.[01]-/.test(call))).toEqual([]);
    expect(runtime.buildEpoch(BASE / EPOCH).pending).toBe(0);
  });
  it('caches a 400 on a review lookup as final', async () => {
    const fake = seeded();
    const proof = '0.0.77-1700000000-000000009';
    fake.forced.set(`/api/v1/transactions/${proof}`, 400);
    fake.forced.set(`/api/v1/topics/${REVIEWS_TOPIC}/messages/1`, 400);
    fake.review({ agentId: 1n, client: WALLET_B1, index: 20n, value: 100n, at: BASE - 50, proof });
    const runtime = runtimeFor(fake);
    await runtime.sync();
    expect(runtime.view()!.result.reviews.map((item) => item.exclusionReason)).toEqual(['hash-mismatch', 'not-human-backed', 'payment-not-found', 'payment-not-found']);
    expect(runtime.buildEpoch(BASE / EPOCH).pending).toBe(0);
    fake.calls = [];
    await runtime.sync();
    expect(fake.calls.filter((call) => /\/(topics|transactions)\//.test(call))).toEqual([]);
  });
  it('T5.8: one gateway 404 on a review file changes nothing', async () => {
    const epoch = BASE / EPOCH;
    const fake = seeded();
    const clean = runtimeFor(fake);
    await clean.sync();

    fake.gatewayMisses.set(`/api/v1/topics/${REVIEWS_TOPIC}/messages/1`, 1);
    const runtime = runtimeFor(fake);
    await runtime.sync();
    expect(runtime.view()!.result.reviews.map((item) => item.exclusionReason)).toEqual(clean.view()!.result.reviews.map((item) => item.exclusionReason));
    expect(runtime.buildEpoch(epoch).snapshot.inputsHash).toBe(clean.buildEpoch(epoch).snapshot.inputsHash);
  });
  it('T5.8: one gateway 404 on a payment does not cache it as empty', async () => {
    const epoch = BASE / EPOCH;
    const fake = seeded();
    const clean = runtimeFor(fake);
    await clean.sync();

    fake.gatewayMisses.set(`/api/v1/transactions/${account(WALLET_B1)}-${BASE - 510}-000000001`, 1);
    const runtime = runtimeFor(fake);
    await runtime.sync();
    expect(runtime.view()!.result.agents.find((item) => item.agentId === '1')).toMatchObject({ score: 90, counted: 1 });
    expect(runtime.buildEpoch(epoch).snapshot.inputsHash).toBe(clean.buildEpoch(epoch).snapshot.inputsHash);
  });
  it('holds an epoch back while a gateway keeps answering 404 for a review file, then recovers', async () => {
    const epoch = BASE / EPOCH;
    const fake = seeded();
    const clean = runtimeFor(fake);
    await clean.sync();

    fake.gatewayMisses.set(`/api/v1/topics/${REVIEWS_TOPIC}/messages/1`, 1_000);
    const runtime = runtimeFor(fake);
    await runtime.sync();
    expect(runtime.store.reviewFile(`hcs://${REVIEWS_TOPIC}/1`)).toBeUndefined();
    expect(runtime.buildEpoch(epoch).pending).toBe(1);

    fake.gatewayMisses.clear();
    await runtime.sync();
    expect(runtime.buildEpoch(epoch)).toMatchObject({ pending: 0, snapshot: { inputsHash: clean.buildEpoch(epoch).snapshot.inputsHash } });
  });
  it('isolates a lookup that keeps failing: other reviews score, the epoch waits, and it recovers', async () => {
    const fake = seeded();
    const proof = '0.0.77-1700000000-000000009';
    fake.payment(WALLET_B1, WALLET_A1, BASE - 60, proof);
    fake.review({ agentId: 1n, client: CREATOR_B, index: 20n, value: 10n, at: BASE - 50, proof });
    fake.forced.set(`/api/v1/transactions/${proof}`, 503);
    const runtime = runtimeFor(fake);

    await expect(runtime.sync()).resolves.toBe(fake.consensus);
    const live = runtime.view()!.result;
    expect(live.reviews).toHaveLength(3);
    expect(live.agents.find((item) => item.agentId === '1')!.score).toBe(90);
    expect(runtime.buildEpoch(BASE / EPOCH).pending).toBe(1);

    fake.forced.clear();
    await runtime.sync();
    expect(runtime.view()!.result.reviews).toHaveLength(4);
    expect(runtime.buildEpoch(BASE / EPOCH).pending).toBe(0);
  });
  it('holds a review back, rather than calling its payment missing, when an account lookup fails', async () => {
    const fake = seeded();
    fake.forced.set(`/api/v1/accounts/${WALLET_A1}`, 503);
    const runtime = runtimeFor(fake);
    await runtime.sync();
    expect(runtime.view()!.result.reviews.map((item) => item.exclusionReason)).toEqual(['not-human-backed', 'payment-not-found']);
    expect(runtime.buildEpoch(BASE / EPOCH).pending).toBe(1);

    fake.forced.clear();
    await runtime.sync();
    expect(runtime.view()!.result.agents.find((item) => item.agentId === '1')).toMatchObject({ score: 90, counted: 1 });
    expect(runtime.buildEpoch(BASE / EPOCH).pending).toBe(0);
  });
  it('still stops and keeps the last view when the mirror dies during enrichment', async () => {
    const fake = seeded();
    const runtime = runtimeFor(fake);
    await runtime.sync();
    const before = runtime.view();
    fake.review({ agentId: 1n, client: CREATOR_B, index: 20n, value: 10n, at: BASE - 50 });
    fake.outageOn = /\/messages\/\d+$/;
    await expect(runtime.sync()).rejects.toBeInstanceOf(MirrorError);
    expect(runtime.view()).toBe(before);
  });
  it('ignores a review pointing outside the reviews topic and never fetches it', async () => {
    const fake = seeded();
    fake.logs.get(REPUTATION)!.push(reputationLog('NewFeedback', {
      agentId: 1n, clientAddress: WALLET_B1, feedbackIndex: 8n, value: 100n, valueDecimals: 0, indexedTag1: 'quality', tag1: 'quality', tag2: '', endpoint: '',
      feedbackURI: 'https://169.254.169.254/latest', feedbackHash: toHex(0, { size: 32 }),
    }, ts(BASE - 50)));
    const runtime = runtimeFor(fake);
    await runtime.sync();
    expect(runtime.view()!.result.reviews.at(-1)!.exclusionReason).toBe('hash-mismatch');
  });
});

describe('epoch loop', () => {
  const epoch = BASE / EPOCH;

  it('publishes the config once and one snapshot per epoch', async () => {
    const fake = seeded();
    const publisher = new RecordingPublisher(fake);
    const loop = await loopFor(runtimeFor(fake), publisher);
    await loop.tick();
    await loop.tick();
    expect(publisher.published).toHaveLength(2);
    const { configVersion } = SCORING_CONFIG;
    expect(JSON.parse(publisher.published[0]!)).toMatchObject({ type: 'scorer-config', configVersion });
    expect(JSON.parse(publisher.published[1]!)).toMatchObject({ epoch, configVersion, epochSeconds: EPOCH });
  });
  it('T5.8: a wiped cache rebuilds the same inputsHash and scores, and publishes nothing twice', async () => {
    const fake = seeded();
    const publisher = new RecordingPublisher(fake);
    const first = runtimeFor(fake);
    await (await loopFor(first, publisher)).tick();
    const published = JSON.parse(publisher.published[1]!);

    const log = { info: vi.fn(), error: vi.fn() };
    const fresh = runtimeFor(fake, new Store(':memory:'));
    await (await loopFor(fresh, publisher, log)).tick();

    expect(fresh.buildEpoch(epoch).snapshot).toEqual(published);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('inputsHash matches'));
    expect(log.error).not.toHaveBeenCalled();
    expect(publisher.published.filter((item) => item.includes('inputsHash'))).toHaveLength(1);
  });
  it('T5.8: the hash does not depend on what the cache knew at the time', async () => {
    const fake = seeded();
    const stranger = addr(0x99);
    fake.review({ agentId: 1n, client: stranger, index: 1n, value: 1n, at: BASE - 100, proof: `${account(WALLET_B1)}-${BASE - 510}-000000001` });
    const early = runtimeFor(fake);
    await early.sync();
    const hash = early.buildEpoch(epoch).snapshot.inputsHash;

    // After the epoch: a payment appears for the cited ID, and the stranger gets an account.
    fake.payment(WALLET_B1, WALLET_A1, BASE + 5, '0.0.999-1700000000-000000001');
    fake.addAccount(stranger, ts(BASE + 5));
    const rebuilt = runtimeFor(fake, new Store(':memory:'));
    await rebuilt.sync();
    expect(rebuilt.buildEpoch(epoch).snapshot.inputsHash).toBe(hash);
  });
  it('T5.8: a schedule executing after the review changes nothing', async () => {
    const fake = seeded();
    const proof = '0.0.77-1700000000-000000009';
    fake.transactions.set(proof, [paymentEntry('SCHEDULECREATE', BASE - 105, proof, feeOnly)]);
    fake.review({ agentId: 1n, client: WALLET_B1, index: 20n, value: 10n, at: BASE - 100, proof });
    const early = runtimeFor(fake);
    await early.sync();
    const hash = early.buildEpoch(epoch).snapshot.inputsHash;

    fake.transactions.get(proof)!.push(paymentEntry('CRYPTOTRANSFER', BASE - 50, proof, paidAgent));
    const rebuilt = runtimeFor(fake, new Store(':memory:'));
    await rebuilt.sync();
    expect(rebuilt.buildEpoch(epoch).snapshot.inputsHash).toBe(hash);
    expect(rebuilt.view()!.result.reviews.at(-1)!.exclusionReason).toBe('payment-not-found');
  });
  it('T5.8: a review after the schedule executed sees it, even if the cache read the ID earlier', async () => {
    const fake = seeded();
    const proof = '0.0.77-1700000000-000000009';
    fake.consensus = ts(BASE - 90);
    fake.transactions.set(proof, [paymentEntry('SCHEDULECREATE', BASE - 105, proof, feeOnly)]);
    fake.review({ agentId: 1n, client: WALLET_U, index: 20n, value: 10n, at: BASE - 100, proof });
    const cached = runtimeFor(fake);
    await cached.sync();

    fake.consensus = ts(BASE + 10);
    fake.transactions.get(proof)!.push(paymentEntry('CRYPTOTRANSFER', BASE - 50, proof, paidAgent));
    fake.review({ agentId: 1n, client: WALLET_B1, index: 21n, value: 70n, at: BASE - 20, proof });
    await cached.sync();
    expect(cached.view()!.result.reviews.at(-1)).toMatchObject({ counted: true, paymentVerified: true });

    const rebuilt = runtimeFor(fake, new Store(':memory:'));
    await rebuilt.sync();
    expect(rebuilt.buildEpoch(epoch).snapshot).toEqual(cached.buildEpoch(epoch).snapshot);
  });
  it('T5.8: a payment made after an earlier review cited its ID still counts for a later one', async () => {
    const fake = seeded();
    const proof = '0.0.77-1700000000-000000009';
    fake.consensus = ts(BASE - 90);
    fake.review({ agentId: 1n, client: WALLET_U, index: 20n, value: 10n, at: BASE - 100, proof });
    const cached = runtimeFor(fake);
    await cached.sync();

    fake.consensus = ts(BASE + 10);
    fake.payment(WALLET_B1, WALLET_A1, BASE - 50, proof);
    fake.review({ agentId: 1n, client: WALLET_B1, index: 21n, value: 70n, at: BASE - 20, proof });
    await cached.sync();
    expect(cached.view()!.result.reviews.at(-1)!.counted).toBe(true);

    const rebuilt = runtimeFor(fake, new Store(':memory:'));
    await rebuilt.sync();
    expect(rebuilt.buildEpoch(epoch).snapshot).toEqual(cached.buildEpoch(epoch).snapshot);
  });
  it('T5.8: citing a sequence before it exists cannot spoil the real review that lands on it', async () => {
    const fake = seeded();
    const next = fake.messages.get(REVIEWS_TOPIC)!.length + 1;
    fake.consensus = ts(BASE - 90);
    fake.logs.get(REPUTATION)!.push(feedbackAt(`hcs://${REVIEWS_TOPIC}/${next}`, 20n, BASE - 100));
    const cached = runtimeFor(fake);
    await cached.sync();

    fake.consensus = ts(BASE + 10);
    fake.payment(WALLET_B1, WALLET_A1, BASE - 50, '0.0.77-1700000000-000000009');
    fake.review({ agentId: 1n, client: WALLET_B1, index: 21n, value: 70n, at: BASE - 20, proof: '0.0.77-1700000000-000000009' });
    await cached.sync();
    expect(cached.view()!.result.reviews.at(-1)!.counted).toBe(true);

    const rebuilt = runtimeFor(fake, new Store(':memory:'));
    await rebuilt.sync();
    expect(rebuilt.buildEpoch(epoch).snapshot).toEqual(cached.buildEpoch(epoch).snapshot);
  });
  describe('wallets with no Hedera account', () => {
    const NEWCOMER = addr(0xfeed);
    const proof = `${account(WALLET_B1)}-${BASE - 60}-000000009`;
    const accountReads = (fake: FakeMirror) => fake.calls.filter((call) => call.startsWith(`/api/v1/accounts/${NEWCOMER}`)).length;
    function cited() {
      const fake = seeded();
      fake.payment(WALLET_B1, WALLET_A1, BASE - 60, proof);
      fake.review({ agentId: 1n, client: NEWCOMER, index: 1n, value: 10n, at: BASE - 50, proof });
      return fake;
    }

    it('reads a missing account once per epoch, even for a linked agent and across a restart', async () => {
      const fake = cited();
      const store = new Store(':memory:');
      const runtime = runtimeFor(fake, store);
      await runtime.sync();
      expect(accountReads(fake)).toBe(1);
      for (let tick = 1; tick <= 5; tick += 1) {
        fake.consensus = ts(BASE + 10 + tick);
        await runtime.sync();
      }
      await runtimeFor(fake, store).sync();
      expect(accountReads(fake)).toBe(1);

      fake.consensus = ts(BASE + EPOCH + 1);
      await runtime.sync();
      await runtime.sync();
      expect(accountReads(fake)).toBe(2);
    });
    it('T5.8: an account created after the miss but before the epoch ended reaches the hash', async () => {
      const fake = cited();
      const runtime = runtimeFor(fake);
      await runtime.sync();

      fake.addAccount(NEWCOMER, ts(BASE + 30));
      fake.consensus = ts(BASE + EPOCH + 5);
      await runtime.sync();

      const epoch = BASE / EPOCH + 1;
      const rebuilt = runtimeFor(fake);
      await rebuilt.sync();
      expect(runtime.buildEpoch(epoch)).toMatchObject({ pending: 0, snapshot: { inputsHash: rebuilt.buildEpoch(epoch).snapshot.inputsHash } });
    });
    it('T5.8: an account created after the epoch stays out of it, whatever the cache knew', async () => {
      const fake = cited();
      const runtime = runtimeFor(fake);
      await runtime.sync();
      const before = runtime.buildEpoch(BASE / EPOCH).snapshot.inputsHash;

      fake.addAccount(NEWCOMER, ts(BASE + 30));
      fake.consensus = ts(BASE + EPOCH + 5);
      await runtime.sync();
      expect(runtime.buildEpoch(BASE / EPOCH).snapshot.inputsHash).toBe(before);
    });
    it('uses a found account at once, once the miss has expired', async () => {
      const fake = cited();
      const runtime = runtimeFor(fake);
      await runtime.sync();
      expect(runtime.store.account(NEWCOMER)).toBeUndefined();
      fake.addAccount(NEWCOMER, ts(BASE + 30));
      fake.consensus = ts(BASE + EPOCH + 5);
      await runtime.sync();
      expect(runtime.store.account(NEWCOMER)).toEqual({ accountId: account(NEWCOMER), createdAt: ts(BASE + 30) });
    });
  });
  it('keeps publishing after the epoch length is lengthened, with the cache intact or wiped', async () => {
    for (const wipe of [false, true]) {
      const fake = seeded();
      const publisher = new RecordingPublisher(fake);
      const store = new Store(':memory:');
      await (await loopFor(runtimeFor(fake, store, {}, 60), publisher)).tick();
      const minuteEpoch = Math.floor((BASE + 10) / 60);
      expect(JSON.parse(publisher.published.at(-1)!)).toMatchObject({ epoch: minuteEpoch, epochSeconds: 60 });

      const hourly = runtimeFor(fake, wipe ? new Store(':memory:') : store);
      const log = { info: vi.fn(), error: vi.fn() };
      const loop = await loopFor(hourly, publisher, log);
      await loop.tick();
      await loop.tick();

      const messages = publisher.published.map((item) => JSON.parse(item));
      expect(messages.filter((item) => 'epoch' in item).map((item) => [item.epoch, item.epochSeconds])).toEqual([[minuteEpoch, 60], [epoch, EPOCH]]);
      expect(messages.filter((item) => item.type === 'scorer-config').map((item) => item.epochSeconds)).toEqual([60, EPOCH]);
      expect(log.error).not.toHaveBeenCalled();
    }
  });
  it('does not republish an epoch of its own series past one from another series on the topic', async () => {
    const fake = seeded();
    const publisher = new RecordingPublisher(fake);
    await (await loopFor(runtimeFor(fake), publisher)).tick();
    await (await loopFor(runtimeFor(fake, new Store(':memory:'), {}, 60), publisher)).tick();
    await (await loopFor(runtimeFor(fake, new Store(':memory:')), publisher)).tick();
    const hourly = publisher.published.map((item) => JSON.parse(item)).filter((item) => item.epochSeconds === EPOCH && 'epoch' in item);
    expect(hourly.map((item) => item.epoch)).toEqual([epoch]);
  });
  it('starts a new series when the config version changes', async () => {
    const fake = seeded();
    const publisher = new RecordingPublisher(fake);
    const store = new Store(':memory:');
    await (await loopFor(runtimeFor(fake, store), publisher)).tick();
    const bumped = new ScorerRuntime({
      store,
      settings: settings(),
      mirror: new MirrorClient({ baseUrl: 'https://mirror.test', fetch: fake.fetch, sleep: async () => {} }),
      config: { ...SCORING_CONFIG, configVersion: SCORING_CONFIG.configVersion + 1, epochSeconds: EPOCH },
    });
    await (await loopFor(bumped, publisher)).tick();
    const snapshots = publisher.published.map((item) => JSON.parse(item)).filter((item) => 'epoch' in item);
    expect(snapshots.map((item) => item.configVersion)).toEqual([SCORING_CONFIG.configVersion, SCORING_CONFIG.configVersion + 1]);
  });
  it('says so when the mirror is behind its own published epoch', async () => {
    const fake = seeded();
    const publisher = new RecordingPublisher(fake);
    const runtime = runtimeFor(fake);
    const log = { info: vi.fn(), error: vi.fn() };
    const loop = await loopFor(runtime, publisher, log);
    await loop.tick();
    fake.consensus = ts(BASE - EPOCH);
    await loop.tick();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('only at epoch'));
  });
  it('does not publish a snapshot with a non-finite score', async () => {
    const fake = seeded();
    const publisher = new RecordingPublisher(fake);
    const runtime = runtimeFor(fake);
    const real = runtime.buildEpoch.bind(runtime);
    vi.spyOn(runtime, 'buildEpoch').mockImplementation((value) => {
      const built = real(value);
      return { ...built, snapshot: { ...built.snapshot, creators: [{ creator: CREATOR_A, score: Number.NaN, P: 0 }] } };
    });
    const log = { info: vi.fn(), error: vi.fn() };
    await (await loopFor(runtime, publisher, log)).tick();
    expect(publisher.published.filter((item) => item.includes('inputsHash'))).toEqual([]);
    expect(runtime.store.snapshot(epoch)).toBeNull();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('non-finite'));
  });
  it('T8.3: a restart catches up, and its scores match a clean run', async () => {
    const fake = seeded();
    const publisher = new RecordingPublisher(fake);
    const store = new Store(':memory:');
    await (await loopFor(runtimeFor(fake, store), publisher)).tick();

    // Down for two epochs, during which a review lands.
    fake.payment(WALLET_B1, WALLET_A1, BASE + 100, '0.0.8-1800000000-000000008');
    fake.review({ agentId: 1n, client: CREATOR_B, index: 1n, value: 70n, at: BASE + 200, proof: '0.0.8-1800000000-000000008' });
    fake.consensus = ts(BASE + 2 * EPOCH + 30);

    await (await loopFor(runtimeFor(fake, store), publisher)).tick();
    const epochs = publisher.published.map((item) => JSON.parse(item)).filter((item) => 'epoch' in item);
    expect(epochs.map((item) => item.epoch)).toEqual([epoch, epoch + 1, epoch + 2]);

    const clean = runtimeFor(fake, new Store(':memory:'));
    await clean.sync();
    expect(clean.buildEpoch(epoch + 2).snapshot).toEqual(epochs.at(-1));
  });
  it('limits backfill and says what it skipped', async () => {
    const fake = seeded();
    const publisher = new RecordingPublisher(fake);
    const store = new Store(':memory:');
    await (await loopFor(runtimeFor(fake, store), publisher)).tick();

    fake.consensus = ts(BASE + 10 * EPOCH);
    const log = { info: vi.fn(), error: vi.fn() };
    await (await loopFor(runtimeFor(fake, store), publisher, log)).tick();
    const epochs = publisher.published.map((item) => JSON.parse(item)).filter((item) => 'epoch' in item);
    expect(epochs.map((item) => item.epoch)).toEqual([epoch, epoch + 8, epoch + 9, epoch + 10]);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('skipping epochs'));
  });
  it('retries a failed publish on the next tick without losing the epoch', async () => {
    const fake = seeded();
    const publisher = new RecordingPublisher(fake);
    const runtime = runtimeFor(fake);
    const loop = await loopFor(runtime, publisher);
    publisher.failing = true;
    await expect(loop.tick()).rejects.toThrow();
    expect(runtime.store.latestPublishedSnapshot()).toBeNull();
    publisher.failing = false;
    await loop.tick();
    expect(runtime.store.latestPublishedSnapshot()?.epoch).toBe(epoch);
  });
});

describe('contract address changes', () => {
  const V2 = '0x00000000000000000000000000000000000dead2';

  function redeployed(): FakeMirror {
    const fake = seeded();
    // v2 was deployed before v1's last log, and links agent 1 to a different creator.
    fake.logs.set(V2, [
      registryLog('CreatorRegistered', { nullifierHash: toHex(2, { size: 32 }), wallet: CREATOR_B }, ts(BASE - 1200)),
      registryLog('CredentialIssued', { holder: WALLET_A1, serial: 1n }, ts(BASE - 1100)),
      registryLog('AgentLinked', { agentId: 1n, creator: CREATOR_B, agentWallet: WALLET_A1, serial: 1n }, ts(BASE - 1100)),
    ]);
    return fake;
  }

  it('drops the old contract and reads the new one from its first log', async () => {
    const fake = redeployed();
    const store = new Store(':memory:');
    await runtimeFor(fake, store).sync();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = runtimeFor(fake, store, { creatorRegistry: V2 });
    await runtime.sync();
    const { state } = runtime.view()!;
    expect(state.links.get('1')?.creator).toBe(CREATOR_B);
    expect([...state.links.keys()]).toEqual(['1']);
    expect([...state.creators.keys()]).toEqual([CREATOR_B]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('creatorRegistry'));
    warn.mockRestore();
  });
  it('leaves the other sources alone', async () => {
    const fake = redeployed();
    const store = new Store(':memory:');
    await runtimeFor(fake, store).sync();
    const cursor = store.cursor('reputation');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runtimeFor(fake, store, { creatorRegistry: V2 });
    expect(store.cursor('reputation')).toBe(cursor);
    expect(store.cursor('creatorRegistry')).toBeNull();
    warn.mockRestore();
  });
  it('drops the events when the address is unset, and ignores case on a restart', async () => {
    const fake = seeded();
    const store = new Store(':memory:');
    await runtimeFor(fake, store).sync();
    const cursor = store.cursor('creatorRegistry');
    runtimeFor(fake, store, { creatorRegistry: REGISTRY.toUpperCase().replace('0X', '0x') });
    expect(store.cursor('creatorRegistry')).toBe(cursor);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unset = runtimeFor(fake, store, { creatorRegistry: null });
    await unset.sync();
    expect(unset.view()!.state.links.size).toBe(0);
    warn.mockRestore();
  });
  it('does not warn on a first start', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runtimeFor(seeded());
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('cache schema', () => {
  it('rebuilds a cache written by an older schema', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'scorer-')), 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE payments (proof TEXT PRIMARY KEY, fact TEXT);
      CREATE TABLE review_files (uri TEXT PRIMARY KEY, message TEXT, consensus_ts TEXT);
      INSERT INTO meta VALUES ('cursor:identity', '1.000000000');`);
    old.close();

    const store = new Store(path);
    expect(store.cursor('identity')).toBeNull();
    const runtime = runtimeFor(seeded(), store);
    await runtime.sync();
    expect(runtime.view()!.result.agents.find((item) => item.agentId === '1')!.score).toBe(90);
    store.close();
  });
});

describe('reading snapshots back from the topic', () => {
  const chunk = (text: string, number: number, total: number, sequence: number): TopicMessage => ({
    consensus_timestamp: ts(BASE + sequence),
    message: Buffer.from(text).toString('base64'),
    sequence_number: sequence,
    chunk_info: { number, total, initial_transaction_id: { account_id: '0.0.1', transaction_valid_start: '1.1', nonce: 0 } },
  });
  it('reassembles chunks in order', () => {
    expect(assembleChunks([chunk('world', 2, 2, 2), chunk('hello ', 1, 2, 1)])).toBe('hello world');
  });
  it('finds the newest snapshot past a config message, across chunks', async () => {
    const fake = new FakeMirror();
    const text = canonicalJson({ agents: [], configVersion: 1, creators: [], epoch: 42, inputsHash: '0xabc' });
    const half = Math.ceil(text.length / 2);
    fake.messages.set(SCORES_TOPIC, [
      chunk(text.slice(0, half), 1, 2, 1),
      chunk(text.slice(half), 2, 2, 2),
      { consensus_timestamp: ts(BASE + 3), message: Buffer.from('{"type":"scorer-config"}').toString('base64'), sequence_number: 3 },
    ]);
    const client = new MirrorClient({ baseUrl: 'https://mirror.test', fetch: fake.fetch, sleep: async () => {} });
    await expect(readLatestSnapshot(client, SCORES_TOPIC)).resolves.toMatchObject({ sequenceNumber: 2, snapshot: { epoch: 42 } });
  });
  it('skips snapshots the caller does not accept', async () => {
    const fake = new FakeMirror();
    const message = (body: object, sequence: number): TopicMessage => ({ consensus_timestamp: ts(BASE + sequence), message: Buffer.from(JSON.stringify(body)).toString('base64'), sequence_number: sequence });
    fake.messages.set(SCORES_TOPIC, [message({ epoch: 1, inputsHash: '0xa', epochSeconds: EPOCH }, 1), message({ epoch: 900, inputsHash: '0xb', epochSeconds: 60 }, 2)]);
    const client = new MirrorClient({ baseUrl: 'https://mirror.test', fetch: fake.fetch, sleep: async () => {} });
    await expect(readLatestSnapshot(client, SCORES_TOPIC, (item) => item.epochSeconds === EPOCH)).resolves.toMatchObject({ sequenceNumber: 1, snapshot: { epoch: 1 } });
  });
  it('returns null for an empty topic', async () => {
    const client = new MirrorClient({ baseUrl: 'https://mirror.test', fetch: new FakeMirror().fetch, sleep: async () => {} });
    await expect(readLatestSnapshot(client, SCORES_TOPIC)).resolves.toBeNull();
  });
});

describe('agent files', () => {
  it('parses the registration format', () => {
    const body = Buffer.from(agentUri('Bot').split(',')[1]!, 'base64').toString('utf8');
    expect(parseAgentProfile(body)).toMatchObject({
      name: 'Bot',
      tags: ['defi'],
      endpoints: { a2a: 'https://a2a.example', mcp: 'https://mcp.example', x402PriceHbar: 2 },
    });
  });
  it('keeps only http and https endpoints', () => {
    const profile = parseAgentProfile(JSON.stringify({
      services: [
        { name: 'web', endpoint: 'javascript:alert(document.cookie)' },
        { name: 'a2a', endpoint: ' JavaScript:alert(1)' },
        { name: 'mcp', endpoint: 'data:text/html,<script>alert(1)</script>' },
      ],
    }));
    expect(profile.endpoints).toEqual({});
    const good = parseAgentProfile(JSON.stringify({ services: [{ name: 'web', endpoint: 'http://agent.example/a' }, { name: 'mcp', endpoint: 'https://agent.example' }] }));
    expect(good.endpoints).toEqual({ web: 'http://agent.example/a', mcp: 'https://agent.example' });
  });
  it('keeps only image URLs that cannot run anything', () => {
    for (const image of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'data:image/svg+xml,<svg onload=alert(1)>', 'data:image/png;base64,AAAA', 'http://example.com/a.png', 'ftp://example.com/a.png', 'https://user:pw@example.com/a.png', 'not a url', '']) {
      expect(parseAgentProfile(JSON.stringify({ image })).image).toBeUndefined();
    }
    expect(parseAgentProfile(JSON.stringify({ image: 'https://example.com/a.png?size=2' })).image).toBe('https://example.com/a.png?size=2');
    expect(parseAgentProfile(JSON.stringify({ image: 7 })).image).toBeUndefined();
  });
  it('turns an ipfs image into an https gateway URL, keeping the case of the CID', () => {
    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const image = (raw: string) => parseAgentProfile(JSON.stringify({ image: raw })).image;
    expect(image(`ipfs://${cid}`)).toBe(`https://ipfs.io/ipfs/${cid}`);
    expect(image(`ipfs://${cid}/images/a.png`)).toBe(`https://ipfs.io/ipfs/${cid}/images/a.png`);
    expect(image(`ipfs://ipfs/${cid}/a.png`)).toBe(`https://ipfs.io/ipfs/${cid}/a.png`);
    expect(image(` IPFS://${cid}/a.png`)).toBe(`https://ipfs.io/ipfs/${cid}/a.png`);
  });
  it('drops an ipfs image that does not stay inside its CID on the gateway', () => {
    for (const raw of ['ipfs://', 'ipfs:///a.png', 'ipfs:Qm', 'ipfs://../../evil', 'ipfs://cid:80/a.png', 'ipfs://a.b/c', 'ipfs://ipfs/', 'ipfs://cid\\..\\..\\evil', 'ipfs://cid/a\\..\\..\\..\\evil', 'ipfs://cid/a\\..\\..\\..\\..\\elsewhere/x.png']) {
      expect(parseAgentProfile(JSON.stringify({ image: raw })).image, raw).toBeUndefined();
    }
    // Dot segments that URL parsing clamps at the root end up inside the CID, which is harmless.
    for (const raw of ['ipfs://cid/../../evil', 'ipfs://cid/%2e%2e/%2e%2e/evil']) {
      expect(parseAgentProfile(JSON.stringify({ image: raw })).image, raw).toBe('https://ipfs.io/ipfs/cid/evil');
    }
  });
  it('reads x402Support as a real boolean, and false for an unreadable file', () => {
    expect(parseAgentProfile(JSON.stringify({ x402Support: true })).acceptsX402).toBe(true);
    for (const body of [JSON.stringify({ x402Support: false }), JSON.stringify({ x402Support: 'true' }), JSON.stringify({ x402Support: 1 }), '{}', 'not json', '[1]', null]) {
      expect(parseAgentProfile(body).acceptsX402, String(body)).toBe(false);
    }
  });
  it('survives junk', () => {
    expect(parseAgentProfile('not json')).toEqual({ tags: [], endpoints: {}, acceptsX402: false });
    expect(parseAgentProfile('[1]').tags).toEqual([]);
    expect(parseAgentProfile(null).endpoints).toEqual({});
  });
  it('reads data URIs without a network call', async () => {
    const stub = vi.fn();
    await expect(loadAgentFile('data:application/json,%7B%22name%22%3A%22x%22%7D', { ipfsGateway: 'https://g/', fetch: stub })).resolves.toBe('{"name":"x"}');
    expect(stub).not.toHaveBeenCalled();
  });
  it('refuses plain http and private hosts', async () => {
    const stub = vi.fn();
    for (const uri of ['http://example.com/a.json', 'https://127.0.0.1/a.json', 'https://169.254.169.254/latest', 'https://[::1]/a.json', 'file:///etc/passwd']) {
      await expect(loadAgentFile(uri, { ipfsGateway: 'https://g/', fetch: stub })).resolves.toBeNull();
    }
    expect(stub).not.toHaveBeenCalled();
  });
});

describe('read API', () => {
  it('lists linked agents with stats', async () => {
    const { get } = await api();
    const { status, body } = await get('/api/agents');
    expect(status).toBe(200);
    expect(body.agents.map((agent: { agentId: string }) => agent.agentId).sort()).toEqual(['1', '2', '4']);
    expect(body.stats).toEqual({ agents: 3, humanBacked: 3, creators: 2, reviewsCounted: 1 });
    expect(body.agents.find((agent: { agentId: string }) => agent.agentId === '1')).toMatchObject({
      name: 'TradeBot A1',
      description: 'trades things',
      image: 'https://example.com/a.png',
      tags: ['defi'],
      owner: CREATOR_A,
      wallet: WALLET_A1,
      creator: CREATOR_A,
      humanBacked: true,
      score: { value: 90, tier: 'Tier 1', isNew: false },
      creatorScore: 90,
      reviewsCounted: 1,
    });
  });
  it('filters by q, humanBacked and minScore', async () => {
    const { get } = await api();
    const ids = async (url: string) => (await get(url)).body.agents.map((agent: { agentId: string }) => agent.agentId);
    expect(await ids('/api/agents?q=reviewer')).toEqual(['2']);
    expect(await ids('/api/agents?q=defi')).toHaveLength(3);
    expect(await ids('/api/agents?humanBacked=true')).toHaveLength(3);
    expect((await ids('/api/agents?minScore=95'))).toEqual(['2']);
  });
  it('rejects a bad query with BAD_REQUEST', async () => {
    const { get } = await api();
    expect(await get('/api/agents?minScore=abc')).toMatchObject({ status: 400, body: { code: 'BAD_REQUEST' } });
    expect(await get('/api/agents?humanBacked=maybe')).toMatchObject({ status: 400, body: { code: 'BAD_REQUEST' } });
  });
  it('serves an agent with reviews, reasons and credentials', async () => {
    const { get } = await api();
    const { status, body } = await get('/api/agents/1');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      agentId: '1',
      endpoints: { a2a: 'https://a2a.example', mcp: 'https://mcp.example', x402PriceHbar: 2 },
      operatorChanged: false,
      reviewsExcluded: 2,
      penaltiesConfirmed: 0,
      credentials: [{ tokenId: '0.0.700', serial: 1, title: 'Human-backed', revoked: false }],
    });
    expect(body.agentUri).toMatch(/^data:/);
    expect(body.compromisedAt).toBeUndefined();
    expect(body.reviews.map((item: { exclusionReason?: string }) => item.exclusionReason)).toEqual(['payment-not-found', 'not-human-backed', undefined]);
    expect(body.reviews[2]).toMatchObject({ value: 90, counted: true, paymentVerified: true, reviewerHumanBacked: true, comment: 'review 1' });
  });
  it('shows a new agent inheriting from its creator', async () => {
    const { get } = await api();
    expect((await get('/api/agents/4')).body.score).toEqual({ value: 90, tier: 'Tier 1', isNew: true });
  });
  it('serves an unlinked agent on request, and keeps it out of lists and snapshots', async () => {
    const { get, runtime } = await api();
    const before = (await get('/api/agents')).body;
    const { body } = await get('/api/agents/3');
    expect(body).toMatchObject({ agentId: '3', creator: null, humanBacked: false, creatorScore: null, score: { value: 0, isNew: false } });
    expect((await get('/api/agents')).body).toEqual(before);
    expect((await get('/api/agents?humanBacked=false')).body).toEqual(before);
    expect(runtime.buildEpoch(BASE / EPOCH).snapshot.agents.map((agent) => agent.agentId)).toEqual(['1', '2', '4']);
  });
  it('does not let a visit to an unlinked agent move a linked agent\'s live score', async () => {
    const fake = seeded();
    const proof = '0.0.77-1700000000-000000009';
    // Agent 5 shares A1's wallet, and is reviewed first with the payment agent 1's review cites.
    fake.logs.get(IDENTITY)!.push(...mint(5n, WALLET_U, BASE - 800, 'Same Wallet'), setWallet(5n, WALLET_A1, BASE - 799));
    fake.payment(CREATOR_B, WALLET_A1, BASE - 150, proof);
    fake.review({ agentId: 5n, client: CREATOR_B, index: 1n, value: 100n, at: BASE - 140, proof });
    fake.review({ agentId: 1n, client: CREATOR_B, index: 1n, value: 30n, at: BASE - 130, proof });
    const { get, runtime } = await api(fake);
    const before = (await get('/api/agents/1')).body;

    await get('/api/agents/5');
    await runtime.sync();
    const after = (await get('/api/agents/1')).body;
    expect(after.score).toEqual(before.score);
    expect(after.reviewsCounted).toBe(2);
    const live = runtime.view()!.result.agents.find((agent) => agent.agentId === '1')!.score;
    expect(runtime.buildEpoch(BASE / EPOCH).snapshot.agents.find((agent) => agent.agentId === '1')!.score).toBe(live);
  });
  it('drops the badge and flags the operator after the NFT is transferred', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(setWallet(1n, '0x', BASE + 1), identityLog('Transfer', { from: CREATOR_A, to: CREATOR_B, tokenId: 1n }, ts(BASE + 1)));
    const { get } = await api(fake);
    expect((await get('/api/agents/1')).body).toMatchObject({ owner: CREATOR_B, creator: CREATOR_A, wallet: null, operatorChanged: true, humanBacked: false });
  });
  it('shows a compromise report', async () => {
    const fake = seeded();
    fake.logs.get(REGISTRY)!.push(registryLog('AgentCompromised', { agentId: 1n, creator: CREATOR_A, timestamp: BigInt(BASE + 1) }, ts(BASE + 1)));
    const { get } = await api(fake);
    const { body } = await get('/api/agents/1');
    expect(body.compromisedAt).toBe(new Date((BASE + 1) * 1000).toISOString());
    expect(body.humanBacked).toBe(false);
  });
  it('keeps the badge through a rotation only once the wallet is synced', async () => {
    const rotated = seeded();
    rotated.logs.get(IDENTITY)!.push(setWallet(1n, WALLET_U, BASE + 1));
    const before = await api(rotated);
    expect((await before.get('/api/agents/1')).body).toMatchObject({ wallet: WALLET_U, humanBacked: false });

    rotated.logs.get(REGISTRY)!.push(
      registryLog('CredentialIssued', { holder: WALLET_U, serial: 4n }, ts(BASE + 2)),
      registryLog('AgentWalletSynced', { agentId: 1n, creator: CREATOR_A, agentWallet: WALLET_U, serial: 4n }, ts(BASE + 2)),
    );
    const after = await api(rotated);
    const { body } = await after.get('/api/agents/1');
    expect(body).toMatchObject({ wallet: WALLET_U, humanBacked: true });
    expect(body.credentials).toMatchObject([
      { serial: 1, title: 'Human-backed', issuer: REGISTRY.toLowerCase() },
      { serial: 4, title: 'Human-backed', issuer: REGISTRY.toLowerCase() },
    ]);
  });
  it('drops the badge from every agent sharing a reported wallet', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(setWallet(2n, WALLET_A1, BASE + 1));
    fake.logs.get(REGISTRY)!.push(
      registryLog('AgentWalletSynced', { agentId: 2n, creator: CREATOR_B, agentWallet: WALLET_A1, serial: 4n }, ts(BASE + 2)),
    );
    const before = await api(fake);
    expect((await before.get('/api/agents/2')).body.humanBacked).toBe(true);

    fake.logs.get(REGISTRY)!.push(registryLog('AgentCompromised', { agentId: 1n, creator: CREATOR_A, timestamp: BigInt(BASE + 3) }, ts(BASE + 3)));
    const after = await api(fake);
    expect((await after.get('/api/agents/2')).body.humanBacked).toBe(false);
  });
  it('keeps the badge on another agent of a reported creator wallet', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(...mint(6n, CREATOR_A, BASE - 800, 'Same Key'));
    fake.logs.get(REGISTRY)!.push(
      registryLog('AgentLinked', { agentId: 6n, creator: CREATOR_A, agentWallet: CREATOR_A, serial: 4n }, ts(BASE - 790)),
      registryLog('AgentCompromised', { agentId: 4n, creator: CREATOR_A, timestamp: BigInt(BASE + 3) }, ts(BASE + 3)),
    );
    const { get } = await api(fake);
    expect((await get('/api/agents/4')).body.humanBacked).toBe(false);
    expect((await get('/api/agents/6')).body.humanBacked).toBe(true);
  });
  it("returns the agent's reply and ignores a stranger's", async () => {
    const fake = seeded();
    const respond = (responder: Address, uri: string, at: number) =>
      reputationLog('ResponseAppended', { agentId: 1n, clientAddress: WALLET_B1, feedbackIndex: 1n, responder, responseURI: uri, responseHash: toHex(1, { size: 32 }) }, ts(at));
    fake.logs.get(REPUTATION)!.push(
      respond(CREATOR_A, 'ipfs://owner', BASE + 1),
      respond(WALLET_A1, 'ipfs://wallet', BASE + 2),
      respond(WALLET_U, 'ipfs://stranger', BASE + 3),
    );
    const { get } = await api(fake);
    const { reviews } = (await get('/api/agents/1')).body;
    const replied = reviews.find((item: { clientAddress: string; feedbackIndex: number }) => item.clientAddress === WALLET_B1 && item.feedbackIndex === 1);
    expect(replied.response).toEqual({
      responder: WALLET_A1,
      uri: 'ipfs://wallet',
      hash: toHex(1, { size: 32 }),
      createdAt: new Date((BASE + 2) * 1000).toISOString(),
    });
    expect(reviews.filter((item: { response?: unknown }) => item.response)).toHaveLength(1);
  });
  it('keeps responses out of the published inputs', async () => {
    const fake = seeded();
    const { runtime } = await api(fake);
    const before = runtime.buildEpoch(BASE / EPOCH + 1).snapshot.inputsHash;
    fake.logs.get(REPUTATION)!.push(
      reputationLog('ResponseAppended', { agentId: 1n, clientAddress: WALLET_B1, feedbackIndex: 1n, responder: CREATOR_A, responseURI: 'x', responseHash: toHex(1, { size: 32 }) }, ts(BASE + 1)),
    );
    await runtime.sync();
    expect(runtime.buildEpoch(BASE / EPOCH + 1).snapshot.inputsHash).toBe(before);
  });
  it('serves a creator', async () => {
    const { get } = await api();
    const { status, body } = await get(`/api/creators/${CREATOR_A.toUpperCase().replace('0X', '0x')}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ address: CREATOR_A, score: 90, tier: 'Tier 1', penaltyTotal: 0, penalties: [] });
    expect(body.agents.map((agent: { agentId: string }) => agent.agentId).sort()).toEqual(['1', '4']);
  });
  it('answers 404 as an ApiError', async () => {
    const { get } = await api();
    for (const url of ['/api/agents/999', '/api/agents/abc', `/api/creators/${WALLET_U}`, '/api/creators/nope']) {
      expect(await get(url)).toMatchObject({ status: 404, body: { code: 'NOT_FOUND', message: expect.any(String) } });
    }
  });
  it('answers with an empty list before the first sync', async () => {
    const { get } = await api(new FakeMirror(), { sync: false });
    expect((await get('/api/agents')).body).toEqual({ agents: [], stats: { agents: 0, humanBacked: 0, creators: 0, reviewsCounted: 0 }, scoresStale: false });
  });
});

const CREATOR_C = addr(0xc);
const WALLET_C1 = addr(0xc1);
const STRANGER = addr(0xdd);
const IDS = (body: { agents: { agentId: string }[] }) => body.agents.map((agent) => agent.agentId).sort();

function fileUri(file: object): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(file)).toString('base64')}`;
}

function setUri(agentId: bigint, newURI: string, at: number): MirrorLog {
  return identityLog('URIUpdated', { agentId, newURI, updatedBy: CREATOR_A }, ts(at));
}

/** Creator C with a linked agent, so B and C can both report on agent 1. */
function withThirdCreator(fake: FakeMirror): void {
  fake.addAccount(CREATOR_C);
  fake.addAccount(WALLET_C1);
  fake.logs.get(IDENTITY)!.push(...mint(8n, CREATOR_C, BASE - 780, 'Reviewer C1'), setWallet(8n, WALLET_C1, BASE - 779));
  fake.logs.get(REGISTRY)!.push(
    registryLog('CreatorRegistered', { nullifierHash: toHex(3, { size: 32 }), wallet: CREATOR_C }, ts(BASE - 775)),
    registryLog('AgentLinked', { agentId: 8n, creator: CREATOR_C, agentWallet: WALLET_C1, serial: 9n }, ts(BASE - 770)),
  );
}

function report(fake: FakeMirror, client: Address, index: bigint, at: number): void {
  const proof = `${account(client)}-${at - 20}-000000001`;
  fake.payment(client, WALLET_A1, at - 10, proof);
  fake.review({ agentId: 1n, client, index, value: 0n, tag1: 'misconduct', tag2: 'fraud', at, proof });
}

describe('agent status', () => {
  const compromise = registryLog('AgentCompromised', { agentId: 1n, creator: CREATOR_A, timestamp: BigInt(BASE + 2) }, ts(BASE + 2));
  const sell = () => identityLog('Transfer', { from: CREATOR_A, to: STRANGER, tokenId: 1n }, ts(BASE + 1));

  it('is active on a healthy agent, in the list and on the agent', async () => {
    const { get } = await api();
    expect((await get('/api/agents')).body.agents.map((agent: { status: string }) => agent.status)).toEqual(['active', 'active', 'active']);
    expect((await get('/api/agents/1')).body.status).toBe('active');
  });
  it('stays active when the wallet is unset but the creator still owns the NFT', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(setWallet(1n, '0x', BASE + 1));
    const { get } = await api(fake);
    expect((await get('/api/agents/1')).body).toMatchObject({ wallet: null, status: 'active', operatorChanged: false });
  });
  it('is operator-changed once the NFT leaves the creator', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(sell());
    const { get } = await api(fake);
    expect((await get('/api/agents/1')).body.status).toBe('operator-changed');
  });
  it('is active again if the NFT returns to the creator', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(sell(), identityLog('Transfer', { from: STRANGER, to: CREATOR_A, tokenId: 1n }, ts(BASE + 3)));
    const { get } = await api(fake);
    expect((await get('/api/agents/1')).body.status).toBe('active');
  });
  it('is compromised on a report', async () => {
    const fake = seeded();
    fake.logs.get(REGISTRY)!.push(compromise);
    const { get } = await api(fake);
    expect((await get('/api/agents/1')).body.status).toBe('compromised');
  });
  it('is compromised when a report and a transfer both apply, on every route', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(sell());
    fake.logs.get(REGISTRY)!.push(compromise);
    const { get } = await api(fake);
    const isOne = (agent: { agentId: string }) => agent.agentId === '1';
    expect((await get('/api/agents/1')).body).toMatchObject({ status: 'compromised', operatorChanged: true });
    expect((await get('/api/agents')).body.agents.find(isOne).status).toBe('compromised');
    expect((await get(`/api/creators/${CREATOR_A}`)).body.agents.find(isOne).status).toBe('compromised');
  });
  it('is active on an unlinked agent, which has no creator to leave', async () => {
    const { get } = await api();
    expect((await get('/api/agents/3')).body.status).toBe('active');
  });
});

describe('acceptsX402 from the agent file', () => {
  it('follows x402Support, and is false for a file that cannot be read', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(
      setUri(1n, fileUri({ name: 'Paid', x402Support: true }), BASE + 1),
      setUri(2n, 'https://127.0.0.1/agent.json', BASE + 1),
    );
    const { get } = await api(fake);
    const list = (await get('/api/agents')).body.agents;
    const accepts = (id: string) => list.find((agent: { agentId: string }) => agent.agentId === id).acceptsX402;
    expect([accepts('1'), accepts('2'), accepts('4')]).toEqual([true, false, false]);
    expect((await get('/api/agents/1')).body.acceptsX402).toBe(true);
  });
  it('serves the sanitised image', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(setUri(1n, fileUri({ image: 'ipfs://bafyabc/a.png' }), BASE + 1), setUri(2n, fileUri({ image: 'http://example.com/a.png' }), BASE + 1));
    const { get } = await api(fake);
    expect((await get('/api/agents/1')).body.image).toBe('https://ipfs.io/ipfs/bafyabc/a.png');
    expect((await get('/api/agents/2')).body).not.toHaveProperty('image');
  });
});

describe('credential kinds', () => {
  it('marks the link credential human-backed and an issuer credential a milestone', async () => {
    const fake = seeded();
    fake.logs.get(REGISTRY)!.push(registryLog('CredentialIssued', { holder: WALLET_A1, serial: 7n }, ts(BASE + 1)));
    const { get } = await api(fake);
    expect((await get('/api/agents/1')).body.credentials).toMatchObject([
      { serial: 1, kind: 'human-backed', title: 'Human-backed' },
      { serial: 7, kind: 'milestone', title: 'Credential #7' },
    ]);
  });
  it('keeps a human-backed credential to link to after a rotation revokes the first one', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(setWallet(1n, WALLET_U, BASE + 1));
    fake.logs.get(REGISTRY)!.push(
      registryLog('CredentialIssued', { holder: WALLET_U, serial: 4n }, ts(BASE + 2)),
      registryLog('AgentWalletSynced', { agentId: 1n, creator: CREATOR_A, agentWallet: WALLET_U, serial: 4n }, ts(BASE + 2)),
      registryLog('CredentialRevoked', { holder: WALLET_A1, serial: 1n }, ts(BASE + 3)),
    );
    const { get } = await api(fake);
    const { credentials } = (await get('/api/agents/1')).body;
    expect(credentials.find((item: { kind: string; revoked: boolean }) => item.kind === 'human-backed' && !item.revoked).serial).toBe(4);
  });
});

describe('penalties on the creator route', () => {
  const DAY = 86_400;
  const HALF_LIFE = SCORING_CONFIG.penaltyHalfLifeDays * DAY;
  const CONFIRMED = BASE + 5;

  function penalised() {
    const fake = seeded();
    withThirdCreator(fake);
    report(fake, WALLET_B1, 7n, BASE + 2);
    report(fake, WALLET_C1, 8n, CONFIRMED);
    return fake;
  }
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  const penaltyAt = async (seconds: number, fake = penalised()) => {
    const { get } = await api(fake, { deps: { now: () => seconds * 1000 } });
    return (await get(`/api/creators/${CREATOR_A}`)).body.penalties[0];
  };

  it('names the reviews that confirmed it, as links HashScan opens', async () => {
    const fake = penalised();
    const [first, second] = fake.logs.get(REPUTATION)!.slice(-2);
    const penalty = await penaltyAt(CONFIRMED, fake);
    expect(penalty).toMatchObject({ agentId: '1', category: 'fraud', confirmedAt: iso(CONFIRMED) });
    expect(penalty.reports).toEqual([
      { clientAddress: WALLET_B1, feedbackIndex: 7, txId: first!.transaction_hash },
      { clientAddress: WALLET_C1, feedbackIndex: 8, txId: second!.transaction_hash },
    ]);
  });
  it('falls back to the consensus timestamp for a report with no usable hash', async () => {
    const fake = penalised();
    fake.logs.get(REPUTATION)!.at(-1)!.transaction_hash = '0.0.5-1700000000-000000001';
    const penalty = await penaltyAt(CONFIRMED, fake);
    expect(penalty.reports[1].txId).toBe(ts(CONFIRMED));
  });
  it('gives the next whole half-life after now, by the wall clock', async () => {
    expect((await penaltyAt(CONFIRMED + 1)).nextHalvingAt).toBe(iso(CONFIRMED + HALF_LIFE));
    expect((await penaltyAt(CONFIRMED + HALF_LIFE - 1)).nextHalvingAt).toBe(iso(CONFIRMED + HALF_LIFE));
    expect((await penaltyAt(CONFIRMED + HALF_LIFE)).nextHalvingAt).toBe(iso(CONFIRMED + 2 * HALF_LIFE));
    expect((await penaltyAt(CONFIRMED + 5 * HALF_LIFE + 1)).nextHalvingAt).toBe(iso(CONFIRMED + 6 * HALF_LIFE));
  });
  it('is always in the future, even with the clock behind the chain', async () => {
    expect((await penaltyAt(CONFIRMED - 1000)).nextHalvingAt).toBe(iso(CONFIRMED + HALF_LIFE));
  });
});

describe('scoresStale', () => {
  const EPOCH_NOW = BASE / EPOCH + 1;
  const snapshot = (epoch: number, epochSeconds = EPOCH) => ({ epoch, configVersion: SCORING_CONFIG.configVersion, epochSeconds, inputsHash: toHex(1, { size: 32 }), agents: [], creators: [] });

  async function clocked(options: ApiOptions = {}, start = EPOCH_NOW * EPOCH) {
    let seconds = start;
    const handle = await api(seeded(), { ...options, deps: { now: () => seconds * 1000 } });
    const stale = async () => {
      const [list, detail] = await Promise.all([handle.get('/api/agents'), handle.get('/api/agents/1')]);
      expect(detail.body.scoresStale).toBe(list.body.scoresStale);
      return list.body.scoresStale as boolean;
    };
    return { ...handle, stale, setClock: (value: number) => (seconds = value) };
  }

  it('turns true at exactly 2 epochs behind', async () => {
    const { runtime, stale, setClock } = await clocked();
    runtime.store.saveSnapshot(snapshot(EPOCH_NOW), 1);
    expect(await stale()).toBe(false);
    setClock((EPOCH_NOW + 2) * EPOCH - 1);
    expect(await stale()).toBe(false);
    setClock((EPOCH_NOW + 2) * EPOCH);
    expect(await stale()).toBe(true);
    runtime.store.saveSnapshot(snapshot(EPOCH_NOW + 2), 2);
    expect(await stale()).toBe(false);
  });
  it('uses the configured epoch length', async () => {
    const short = runtimeFor(seeded(), new Store(':memory:'), {}, 60, { now: () => (BASE + 120) * 1000 });
    short.store.saveSnapshot(snapshot(BASE / 60, 60), 1);
    expect(short.scoresStale()).toBe(true);
    const long = runtimeFor(seeded(), new Store(':memory:'), {}, EPOCH, { now: () => (BASE + 120) * 1000 });
    long.store.saveSnapshot(snapshot(BASE / EPOCH), 1);
    expect(long.scoresStale()).toBe(false);
  });
  it('notices a dead scorer, whose mirror time has stopped moving', async () => {
    const { runtime, stale, setClock } = await clocked();
    runtime.store.saveSnapshot(snapshot(EPOCH_NOW), 1);
    const frozen = runtime.view()!.asOf;
    setClock((EPOCH_NOW + 5) * EPOCH);
    expect(runtime.view()!.asOf).toBe(frozen);
    expect(await stale()).toBe(true);
  });
  it('does not count a snapshot that was saved but never published', async () => {
    const { runtime, stale, setClock } = await clocked();
    runtime.store.saveSnapshot(snapshot(EPOCH_NOW - 3), 1);
    runtime.store.saveSnapshot(snapshot(EPOCH_NOW), null);
    setClock(EPOCH_NOW * EPOCH + 1);
    expect(await stale()).toBe(true);
  });
  it('is not fooled by the far larger epoch numbers of a shorter series', async () => {
    const { runtime, stale, setClock } = await clocked();
    runtime.store.saveSnapshot(snapshot(EPOCH_NOW), 1);
    runtime.store.saveSnapshot(snapshot(BASE / 60, 60), 2);
    setClock((EPOCH_NOW + 2) * EPOCH);
    expect(await stale()).toBe(true);
  });
  it('gives a fresh deployment two epochs, then alarms until something is published', async () => {
    const start = EPOCH_NOW * EPOCH + 1800;
    const { runtime, stale, setClock } = await clocked({}, start);
    expect(await stale()).toBe(false);
    setClock(start + 2 * EPOCH - 1);
    expect(await stale()).toBe(false);
    setClock(start + 2 * EPOCH);
    expect(await stale()).toBe(true);
    setClock(start + 1000 * EPOCH);
    expect(await stale()).toBe(true);
    runtime.store.saveSnapshot(snapshot(EPOCH_NOW + 1000), 1);
    expect(await stale()).toBe(false);
  });
  it('does not restart the grace period when the process restarts', async () => {
    const store = new Store(':memory:');
    const start = EPOCH_NOW * EPOCH;
    runtimeFor(seeded(), store, {}, EPOCH, { now: () => start * 1000 });
    const restarted = runtimeFor(seeded(), store, {}, EPOCH, { now: () => (start + 2 * EPOCH) * 1000 });
    expect(restarted.scoresStale()).toBe(true);
  });
  it('alarms even when no sync has ever worked', async () => {
    const start = EPOCH_NOW * EPOCH;
    const store = new Store(':memory:');
    let seconds = start;
    const { get } = await api(new FakeMirror(), { sync: false, store, deps: { now: () => seconds * 1000 } });
    expect((await get('/api/agents')).body.scoresStale).toBe(false);
    seconds = start + 2 * EPOCH;
    expect((await get('/api/agents')).body).toMatchObject({ agents: [], scoresStale: true });
  });
  it('is false after a real publish', async () => {
    const fake = seeded();
    fake.consensus = ts(BASE + EPOCH + 5);
    const runtime = runtimeFor(fake, new Store(':memory:'), {}, EPOCH, { now: () => (BASE + EPOCH + 5) * 1000 });
    const loop = await loopFor(runtime, new RecordingPublisher(fake));
    await loop.tick();
    expect(runtime.scoresStale()).toBe(false);
  });
});

describe('humanBacked filter and stats', () => {
  function withUnlinked() {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(...mint(7n, CREATOR_B, BASE - 760, 'Waiting Bot'));
    return fake;
  }
  it('filters only on true', async () => {
    const { get } = await api(withUnlinked());
    expect(IDS((await get('/api/agents')).body)).toEqual(['1', '2', '4', '7']);
    expect(IDS((await get('/api/agents?humanBacked=false')).body)).toEqual(['1', '2', '4', '7']);
    expect(IDS((await get('/api/agents?humanBacked=true')).body)).toEqual(['1', '2', '4']);
  });
  it('T6.9: the toggle has something to hide, including an agent that lost its badge', async () => {
    const fake = withUnlinked();
    fake.logs.get(IDENTITY)!.push(identityLog('Transfer', { from: CREATOR_A, to: STRANGER, tokenId: 4n }, ts(BASE + 1)));
    const { get } = await api(fake);
    expect(IDS((await get('/api/agents?humanBacked=true')).body)).toEqual(['1', '2']);
    expect(IDS((await get('/api/agents?humanBacked=false')).body)).toEqual(['1', '2', '4', '7']);
  });
  it('keeps stats global whatever the filters', async () => {
    const { get } = await api(withUnlinked());
    const { stats } = (await get('/api/agents')).body;
    expect(stats).toEqual({ agents: 4, humanBacked: 3, creators: 2, reviewsCounted: 1 });
    for (const query of ['q=reviewer', 'q=nothing-matches-this', 'humanBacked=true', 'humanBacked=false', 'minScore=100', `owner=${CREATOR_B}`, 'q=reviewer&humanBacked=true&minScore=95']) {
      const { body } = await get(`/api/agents?${query}`);
      expect(body.stats, query).toEqual(stats);
    }
    expect((await get('/api/agents?q=nothing-matches-this')).body.agents).toEqual([]);
  });
});

describe('review transaction IDs', () => {
  it('passes a 0x hash through', async () => {
    const fake = seeded();
    const hash = fake.logs.get(REPUTATION)![0]!.transaction_hash;
    const { get } = await api(fake);
    expect((await get('/api/agents/1')).body.reviews.at(-1).txId).toBe(hash);
  });
  it('never serves a form HashScan might not open', async () => {
    for (const bad of ['0.0.5@1700000000.000000001', '0.0.5-1700000000-000000001', `0x${'ab'.repeat(48)}`, '0xabc', '']) {
      const fake = seeded();
      const logs = fake.logs.get(REPUTATION)!;
      logs[0]!.transaction_hash = bad;
      const { get } = await api(fake);
      expect((await get('/api/agents/1')).body.reviews.at(-1).txId, bad).toBe(logs[0]!.timestamp);
    }
  });
  it('only ever serves one of the two forms', async () => {
    const { get } = await api();
    for (const { txId } of (await get('/api/agents/1')).body.reviews) {
      expect(txId).toMatch(/^(0x[0-9a-fA-F]{64}|\d+\.\d{9})$/);
    }
  });
});

describe('unlinked agents of verified creators', () => {
  function discovered() {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(...mint(7n, CREATOR_B, BASE - 760, 'Waiting Bot'));
    return fake;
  }
  const one = (body: { agents: { agentId: string }[] }, id: string) => body.agents.find((agent) => agent.agentId === id);

  it('lists them as not human-backed, with no creator', async () => {
    const { get } = await api(discovered());
    expect(one((await get('/api/agents')).body, '7')).toMatchObject({
      name: 'Waiting Bot', owner: CREATOR_B, wallet: CREATOR_B, creator: null, humanBacked: false, creatorScore: null, status: 'active', score: { value: 0, isNew: false },
    });
  });
  it('reads them from logs already ingested, with no extra or topic-filtered Mirror reads', async () => {
    const fake = discovered();
    await api(fake);
    expect(fake.calls.filter((call) => /[?&]topic\d=/.test(call))).toEqual([]);
    const plain = seeded();
    await api(plain);
    expect(fake.calls.length - plain.calls.length).toBeLessThanOrEqual(2);
  });
  it('finds an agent minted before its owner verified', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.unshift(...mint(7n, CREATOR_B, BASE - 2000, 'Early Bot'));
    const { get } = await api(fake);
    expect(one((await get('/api/agents')).body, '7')).toMatchObject({ creator: null, humanBacked: false });
  });
  it('leaves out an agent a stranger minted and transferred to a creator, who never consented', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(identityLog('Transfer', { from: WALLET_U, to: CREATOR_B, tokenId: 3n }, ts(BASE - 500)));
    const { get } = await api(fake);
    expect(one((await get('/api/agents')).body, '3')).toBeUndefined();
  });
  it('gives a stranger no way to add to the list, the stats or a creator\'s resume results', async () => {
    const fake = seeded();
    const { get: before } = await api(seeded());
    for (let id = 0; id < 10; id += 1) {
      const agentId = BigInt(200 + id);
      fake.logs.get(IDENTITY)!.push(...mint(agentId, STRANGER, BASE - 700 + id, `Pushed ${id}`));
      fake.logs.get(IDENTITY)!.push(identityLog('Transfer', { from: STRANGER, to: CREATOR_B, tokenId: agentId }, ts(BASE - 600 + id)));
    }
    const { get } = await api(fake);
    expect((await get('/api/agents')).body.stats).toEqual((await before('/api/agents')).body.stats);
    expect(IDS((await get('/api/agents?humanBacked=false')).body)).toEqual(IDS((await before('/api/agents?humanBacked=false')).body));
    expect(IDS((await get(`/api/agents?owner=${CREATOR_B}`)).body)).toEqual(['2']);
  });
  it('serves a transferred-in agent on request, and lists it once its new owner links it', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(identityLog('Transfer', { from: WALLET_U, to: CREATOR_B, tokenId: 3n }, ts(BASE - 500)));
    const { get, runtime } = await api(fake);
    expect(await get('/api/agents/3')).toMatchObject({ status: 200, body: { owner: CREATOR_B, creator: null } });
    fake.logs.get(REGISTRY)!.push(registryLog('AgentLinked', { agentId: 3n, creator: CREATOR_B, agentWallet: CREATOR_B, serial: 5n }, ts(BASE + 1)));
    await runtime.sync();
    expect(one((await get('/api/agents')).body, '3')).toMatchObject({ creator: CREATOR_B });
  });
  it('offers an unlinked agent only to a wallet that can link it', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(
      ...mint(7n, CREATOR_B, BASE - 760, 'Sold To A Stranger'),
      identityLog('Transfer', { from: CREATOR_B, to: STRANGER, tokenId: 7n }, ts(BASE - 750)),
      ...mint(8n, CREATOR_B, BASE - 740, 'Sold To A Creator'),
      identityLog('Transfer', { from: CREATOR_B, to: CREATOR_A, tokenId: 8n }, ts(BASE - 730)),
    );
    const { get } = await api(fake);
    expect((await get(`/api/agents?owner=${STRANGER}`)).body.agents).toEqual([]);
    expect((await get(`/api/agents?owner=${CREATOR_B}`)).body.agents.map((agent: { agentId: string }) => agent.agentId)).toEqual(['2']);
    expect(one((await get(`/api/agents?owner=${CREATOR_A}`)).body, '8')).toMatchObject({ creator: null, owner: CREATOR_A });
    // Registered by a creator, so still listed. Only the owner filter asks who can link it.
    expect(one((await get('/api/agents')).body, '7')).toMatchObject({ creator: null, owner: STRANGER });
  });
  it('still finds a linked agent under a new owner who is no creator', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(identityLog('Transfer', { from: CREATOR_B, to: STRANGER, tokenId: 2n }, ts(BASE - 500)));
    const { get } = await api(fake);
    expect(one((await get(`/api/agents?owner=${STRANGER}`)).body, '2')).toMatchObject({ creator: CREATOR_B, status: 'operator-changed' });
  });
  it('leaves out other projects\' agents in the shared registry', async () => {
    const { get } = await api(discovered());
    expect(one((await get('/api/agents')).body, '3')).toBeUndefined();
  });
  it('moves an agent to linked once it is linked', async () => {
    const fake = discovered();
    const { get, runtime } = await api(fake);
    fake.logs.get(REGISTRY)!.push(registryLog('AgentLinked', { agentId: 7n, creator: CREATOR_B, agentWallet: CREATOR_B, serial: 5n }, ts(BASE + 1)));
    await runtime.sync();
    expect(one((await get('/api/agents')).body, '7')).toMatchObject({ creator: CREATOR_B, humanBacked: true });
  });
  it('keeps them out of snapshots and leaves the published hash alone', async () => {
    const epoch = BASE / EPOCH;
    const fake = seeded();
    const { runtime, get } = await api(fake);
    const before = runtime.buildEpoch(epoch).snapshot;

    fake.logs.get(IDENTITY)!.push(...mint(7n, CREATOR_B, BASE - 1, 'Waiting Bot'));
    await runtime.sync();
    expect(IDS((await get('/api/agents')).body)).toContain('7');
    const after = runtime.buildEpoch(epoch).snapshot;
    expect(after.agents.map((agent) => agent.agentId)).toEqual(['1', '2', '4']);
    expect(after.inputsHash).toBe(before.inputsHash);
  });
  it('does not hold an epoch back on a review of one that cannot be fetched', async () => {
    const fake = discovered();
    fake.review({ agentId: 7n, client: WALLET_B1, index: 1n, value: 50n, at: BASE - 100 });
    fake.forced.set(`/api/v1/topics/${REVIEWS_TOPIC}/messages/4`, 503);
    const { runtime } = await api(fake);
    expect(runtime.buildEpoch(BASE / EPOCH).pending).toBe(0);
  });
  it('lets onboarding find an unlinked agent by owner, in any case', async () => {
    const { get } = await api(discovered());
    const upper = `0x${CREATOR_B.slice(2).toUpperCase()}`;
    expect(IDS((await get(`/api/agents?owner=${CREATOR_B}`)).body)).toEqual(['2', '7']);
    expect(IDS((await get(`/api/agents?owner=${upper}`)).body)).toEqual(['2', '7']);
    expect((await get(`/api/agents?owner=${CREATOR_B}`)).body.agents.filter((agent: { creator: string | null }) => agent.creator === null).map((agent: { agentId: string }) => agent.agentId)).toEqual(['7']);
    expect((await get(`/api/agents?owner=${STRANGER}`)).body.agents).toEqual([]);
  });
  it('rejects an owner that is not an address', async () => {
    const { get } = await api();
    expect(await get('/api/agents?owner=nope')).toMatchObject({ status: 400, body: { code: 'BAD_REQUEST' } });
  });
});

describe('agent ID 0 and creator 404s', () => {
  function withAgentZero(linked: boolean) {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(...mint(0n, CREATOR_B, BASE - 760, 'Agent Zero'));
    if (linked) fake.logs.get(REGISTRY)!.push(registryLog('AgentLinked', { agentId: 0n, creator: CREATOR_B, agentWallet: CREATOR_B, serial: 6n }, ts(BASE - 750)));
    return fake;
  }
  it('serves a linked agent 0, with its reviews', async () => {
    const fake = withAgentZero(true);
    fake.review({ agentId: 0n, client: WALLET_A1, index: 1n, value: 80n, at: BASE - 100 });
    const { get } = await api(fake);
    expect((await get('/api/agents/0')).body).toMatchObject({ status: 'active', agentId: '0', name: 'Agent Zero', creator: CREATOR_B, humanBacked: true, reviews: [{ feedbackIndex: 1 }] });
    expect((await get('/api/agents/000')).body.agentId).toBe('0');
    expect(IDS((await get('/api/agents')).body)).toContain('0');
    expect(IDS((await get(`/api/creators/${CREATOR_B}`)).body)).toContain('0');
  });
  it('serves an unlinked agent 0 from the list and by ID', async () => {
    const { get } = await api(withAgentZero(false));
    expect(IDS((await get('/api/agents')).body)).toContain('0');
    expect((await get('/api/agents/0')).body).toMatchObject({ agentId: '0', creator: null, humanBacked: false });
  });
  it('answers a stranger\'s agent 0 through the lookup path', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(...mint(0n, WALLET_U, BASE - 760, 'Agent Zero'));
    const { get } = await api(fake);
    expect((await get('/api/agents/0')).status).toBe(200);
  });
  it('answers 404 for an agent 0 that does not exist', async () => {
    const { get } = await api();
    expect(await get('/api/agents/0')).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
  });
  it('answers 404 as an ApiError for a wallet that owns agents but never verified', async () => {
    const { get } = await api();
    expect(await get(`/api/creators/${WALLET_U}`)).toEqual(expect.objectContaining({ status: 404, body: { code: 'NOT_FOUND', message: 'Creator not found.' } }));
  });
  it('answers 404 for every creator before the first sync', async () => {
    const { get } = await api(new FakeMirror(), { sync: false });
    expect(await get(`/api/creators/${CREATOR_A}`)).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
  });
  it('answers 200 for a verified creator with no agents', async () => {
    const fake = seeded();
    fake.logs.get(REGISTRY)!.push(registryLog('CreatorRegistered', { nullifierHash: toHex(3, { size: 32 }), wallet: CREATOR_C }, ts(BASE - 500)));
    const { get } = await api(fake);
    expect(await get(`/api/creators/${CREATOR_C}`)).toMatchObject({ status: 200, body: { address: CREATOR_C, agents: [], penalties: [] } });
  });
});

describe('hostile agent files', () => {
  /** Under the 256 KB cap, with every field a list response carries sized to fill it. */
  const hostile = () => JSON.stringify({
    name: 'n'.repeat(60_000),
    description: 'd'.repeat(60_000),
    image: `https://example.com/${'i'.repeat(60_000)}.png`,
    tags: Array.from({ length: 6_000 }, (_, index) => `tag-${index}`),
    services: [{ name: 'A2A', endpoint: `https://a2a.example/${'e'.repeat(10_000)}` }, { name: 'MCP', endpoint: 'https://mcp.example' }],
  });
  const uriOf = (body: string) => `data:application/json;base64,${Buffer.from(body).toString('base64')}`;
  function creatorsAgents(count: number) {
    const fake = seeded();
    for (let id = 0; id < count; id += 1) {
      const agentId = BigInt(300 + id);
      fake.logs.get(IDENTITY)!.push(
        identityLog('Transfer', { from: addr(0), to: CREATOR_B, tokenId: agentId }, ts(BASE - 700 + id)),
        identityLog('Registered', { agentId, agentURI: uriOf(hostile()), owner: CREATOR_B }, ts(BASE - 700 + id)),
      );
    }
    return fake;
  }

  it('bounds every field of a profile, however large the file', () => {
    const profile = parseAgentProfile(hostile());
    expect(profile.name!.length).toBeLessThanOrEqual(256);
    expect(profile.description!.length).toBeLessThanOrEqual(4000);
    expect(profile.image).toBeUndefined();
    expect(profile.tags.length).toBeLessThanOrEqual(32);
    expect(profile.endpoints).toEqual({ mcp: 'https://mcp.example' });
    expect(JSON.stringify(profile).length).toBeLessThan(8_000);
  });
  it('drops tags too long to be tags, and never splits a character', () => {
    const profile = parseAgentProfile(JSON.stringify({ name: `${'n'.repeat(255)}\u{1F600}`, tags: ['t'.repeat(65), 'defi'] }));
    expect(profile.name).toBe('n'.repeat(255));
    expect(profile.tags).toEqual(['defi']);
  });
  it('leaves a file the agent-file route accepts as it is', () => {
    const description = 'd'.repeat(3_500);
    expect(parseAgentProfile(JSON.stringify({ name: 'Ordinary', description, tags: ['a', 'b'] }))).toMatchObject({ name: 'Ordinary', description, tags: ['a', 'b'] });
  });
  it('keeps a list of oversized files small', async () => {
    const { app } = await api(creatorsAgents(5));
    const response = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(response.json().agents).toHaveLength(8);
    expect(response.payload.length).toBeLessThan(60_000);
  });
  it('reads and parses each file once, not once per request', async () => {
    const { get, runtime } = await api(creatorsAgents(5));
    await get('/api/agents');
    const reads = vi.spyOn(runtime.store, 'agentFile');
    const parses = vi.spyOn(JSON, 'parse');
    await get('/api/agents?q=nothing-matches');
    await get('/api/agents?humanBacked=true');
    // Longer than any response here, so this counts agent files and not this test reading a reply.
    const parsed = parses.mock.calls.filter(([text]) => typeof text === 'string' && text.length >= hostile().length).length;
    parses.mockRestore();
    expect(reads).not.toHaveBeenCalled();
    expect(parsed).toBe(0);
  });
  it('picks up a file that could not be read at first, once a sync finds it', async () => {
    const fake = seeded();
    const uri = 'https://files.example/late.json';
    fake.logs.get(IDENTITY)!.push(
      identityLog('Transfer', { from: addr(0), to: CREATOR_B, tokenId: 7n }, ts(BASE - 700)),
      identityLog('Registered', { agentId: 7n, agentURI: uri, owner: CREATOR_B }, ts(BASE - 700)),
    );
    const { get, runtime } = await api(fake);
    expect((await get('/api/agents/7')).body.name).toBe('Agent #7');
    runtime.store.saveAgentFile(uri, JSON.stringify({ name: 'Found Later' }), 1);
    expect((await get('/api/agents/7')).body.name).toBe('Found Later');
  });
  it('serves a new file when an agent changes its URI', async () => {
    const fake = seeded();
    const { get, runtime } = await api(fake);
    expect((await get('/api/agents/1')).body.name).toBe('TradeBot A1');
    fake.logs.get(IDENTITY)!.push(identityLog('URIUpdated', { agentId: 1n, newURI: agentUri('Renamed'), updatedBy: CREATOR_A }, ts(BASE + 1)));
    await runtime.sync();
    expect((await get('/api/agents/1')).body.name).toBe('Renamed');
  });
});
describe('reviews that make no progress', () => {
  const NOWHERE = addr(0xdead);
  const proof = `${account(WALLET_B1)}-${BASE - 800}-000000009`;

  /** Twelve reviews of a stranger's agent whose accounts Mirror does not have, then one on a creator's. */
  function blocked(blockers = 12) {
    const fake = seeded();
    fake.payment(WALLET_B1, WALLET_A1, BASE - 800, proof);
    fake.logs.get(IDENTITY)!.push(
      ...mint(9n, STRANGER, BASE - 900, 'Blocker'),
      setWallet(9n, NOWHERE, BASE - 899),
      ...mint(7n, CREATOR_B, BASE - 760, 'Waiting Bot'),
    );
    for (let index = 1; index <= blockers; index += 1) {
      fake.review({ agentId: 9n, client: addr(0xd000 + index), index: BigInt(index), value: 100n, at: BASE - 600 + index, proof });
    }
    return fake;
  }
  const accountReads = (fake: FakeMirror) => fake.calls.filter((call) => call.startsWith('/api/v1/accounts/')).length;

  it('cannot hold later reviews back by having no Hedera account', async () => {
    const fake = blocked();
    const { get, runtime } = await api(fake);
    await get('/api/agents/9');
    fake.review({ agentId: 7n, client: WALLET_U, index: 1n, value: 0n, at: BASE + 5 });
    for (let tick = 1; tick <= 3; tick += 1) {
      fake.consensus = ts(BASE + 10 + tick);
      await runtime.sync();
    }
    expect((await get('/api/agents/7')).body.reviews).toHaveLength(1);
    expect((await get('/api/agents/9')).body.reviews).toHaveLength(12);
  });
  it('stops reading the mirror for them within an epoch', async () => {
    const fake = blocked();
    const { get, runtime } = await api(fake);
    await get('/api/agents/9');
    for (let tick = 1; tick <= 3; tick += 1) {
      fake.consensus = ts(BASE + 10 + tick);
      await runtime.sync();
    }
    const before = accountReads(fake);
    for (let tick = 4; tick <= 10; tick += 1) {
      fake.consensus = ts(BASE + 10 + tick);
      await runtime.sync();
    }
    expect(accountReads(fake)).toBe(before);
  });
  it('still gets through when the misses expire at an epoch boundary', async () => {
    const fake = blocked(25);
    const { get, runtime } = await api(fake);
    await get('/api/agents/9');
    for (let tick = 1; tick <= 3; tick += 1) {
      fake.consensus = ts(BASE + 10 + tick);
      await runtime.sync();
    }
    fake.consensus = ts(BASE + EPOCH + 1);
    await runtime.sync();
    fake.review({ agentId: 7n, client: WALLET_U, index: 1n, value: 0n, at: BASE + EPOCH + 2 });
    for (let tick = 1; tick <= 4; tick += 1) {
      fake.consensus = ts(BASE + EPOCH + 10 + tick);
      await runtime.sync();
    }
    expect((await get('/api/agents/7')).body.reviews).toHaveLength(1);
  });
});
describe('the live view never moves backwards', () => {
  function withColdAgent() {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(...mint(9n, STRANGER, BASE - 700, 'Cold'));
    fake.review({ agentId: 9n, client: WALLET_U, index: 1n, value: 40n, at: BASE - 600 });
    return fake;
  }
  const compromise = (agentId: bigint, at: number) => registryLog('AgentCompromised', { agentId, creator: CREATOR_A, timestamp: BigInt(at) }, ts(at));

  it('keeps a compromise a sync found while a lookup was waiting on the mirror', async () => {
    const fake = withColdAgent();
    const { get, runtime } = await api(fake);
    const reached = fake.hold(/\/messages\/4$/);
    const visit = get('/api/agents/9');
    const release = await reached;

    fake.logs.get(REGISTRY)!.push(compromise(1n, BASE + 15));
    fake.consensus = ts(BASE + 20);
    await runtime.sync();
    expect((await get('/api/agents/1')).body).toMatchObject({ status: 'compromised', updatedAt: toIso(ts(BASE + 20)) });

    release();
    expect(await visit).toMatchObject({ status: 200, body: { agentId: '9', reviews: [{ value: 40 }] } });
    expect((await get('/api/agents/1')).body).toMatchObject({ status: 'compromised', updatedAt: toIso(ts(BASE + 20)) });
    expect(runtime.view()!.asOf).toBe(ts(BASE + 20));
  });
  it('does not go back when a sync reads a mirror that is behind the last one', async () => {
    const fake = seeded();
    const { get, runtime } = await api(fake);
    fake.logs.get(REGISTRY)!.push(compromise(1n, BASE + 15));
    fake.consensus = ts(BASE + 20);
    await runtime.sync();
    fake.consensus = ts(BASE + 12);
    await runtime.sync();
    expect((await get('/api/agents/1')).body.status).toBe('compromised');
    expect(runtime.view()!.asOf).toBe(ts(BASE + 20));
  });
  it('does not go back across a restart either', async () => {
    const fake = seeded();
    const store = new Store(':memory:');
    const runtime = runtimeFor(fake, store);
    fake.consensus = ts(BASE + 20);
    await runtime.sync();
    fake.consensus = ts(BASE + 12);
    const restarted = runtimeFor(fake, store);
    await restarted.sync();
    expect(restarted.view()!.asOf).toBe(ts(BASE + 20));
  });
  it('still moves forward after a lookup', async () => {
    const fake = withColdAgent();
    const { get, runtime } = await api(fake);
    await get('/api/agents/9');
    expect(runtime.view()!.asOf).toBe(ts(BASE + 10));
    fake.consensus = ts(BASE + 30);
    await runtime.sync();
    expect(runtime.view()!.asOf).toBe(ts(BASE + 30));
  });
});
describe('read route limits', () => {
  const LIMIT = { max: 3, timeWindow: 60_000 };
  const mirrorCalls = (fake: FakeMirror) => fake.calls.length;

  /** A stranger's agent with reviews nothing has fetched yet. */
  function spammed(reviews: number) {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(...mint(9n, STRANGER, BASE - 700, 'Spammed'));
    for (let index = 1; index <= reviews; index += 1) {
      fake.review({ agentId: 9n, client: WALLET_U, index: BigInt(index), value: 1n, at: BASE - 600 + index });
    }
    return fake;
  }
  function strangers(count: number) {
    const fake = seeded();
    for (let id = 0; id < count; id += 1) {
      fake.logs.get(IDENTITY)!.push(...mint(BigInt(100 + id), STRANGER, BASE - 700 + id, `Bot ${id}`));
    }
    return fake;
  }

  it('answers 429 as an ApiError with retry-after, per route and per client', async () => {
    const { get } = await api(seeded(), { rateLimits: { agentListByIp: LIMIT, agentByIp: LIMIT, creatorByIp: LIMIT } });
    for (const url of ['/api/agents', '/api/agents/1', `/api/creators/${CREATOR_A}`]) {
      for (let i = 0; i < 3; i += 1) expect((await get(url)).status).toBe(200);
      const refused = await get(url);
      expect(refused).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED', message: expect.any(String) } });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect((await get(url, '203.0.113.9')).status).toBe(200);
    }
  });
  it('leaves room for the debounced Explorer at its fastest: 200 searches in a minute', async () => {
    const { get } = await api();
    for (let i = 0; i < 200; i += 1) expect((await get(`/api/agents?q=${i}`)).status).toBe(200);
  });
  it('asks the mirror nothing for an agent that does not exist', async () => {
    const fake = seeded();
    const { get } = await api(fake);
    const before = mirrorCalls(fake);
    for (let id = 500; id < 520; id += 1) expect((await get(`/api/agents/${id}`)).status).toBe(404);
    expect(mirrorCalls(fake)).toBe(before);
  });
  it('asks the mirror nothing for repeat visits to a looked-up agent, and spends no allowance on them', async () => {
    const fake = spammed(2);
    const { get } = await api(fake, { rateLimits: { agentLookupByIp: { max: 1, timeWindow: 60_000 } } });
    expect((await get('/api/agents/9')).status).toBe(200);
    const before = mirrorCalls(fake);
    for (let i = 0; i < 20; i += 1) expect((await get('/api/agents/9')).status).toBe(200);
    expect(mirrorCalls(fake)).toBe(before);
  });
  it('spends no allowance on linked agents or unlinked agents of creators', async () => {
    const fake = seeded();
    fake.logs.get(IDENTITY)!.push(...mint(7n, CREATOR_B, BASE - 760, 'Waiting Bot'));
    const { get } = await api(fake, { rateLimits: { agentLookupByIp: { max: 1, timeWindow: 60_000 }, agentLookupTotal: { max: 1, timeWindow: 60_000 } } });
    for (let i = 0; i < 5; i += 1) {
      expect((await get('/api/agents/1')).status).toBe(200);
      expect((await get('/api/agents/7')).status).toBe(200);
    }
  });
  it('limits how many new agents one client can look up', async () => {
    const { get } = await api(strangers(5), { rateLimits: { agentLookupByIp: LIMIT } });
    const statuses = [];
    for (let id = 100; id < 105; id += 1) statuses.push((await get(`/api/agents/${id}`)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect((await get('/api/agents/1')).status).toBe(200);
  });
  it('limits lookups across clients, so many addresses cannot add up', async () => {
    const { get } = await api(strangers(5), { rateLimits: { agentLookupTotal: LIMIT } });
    const responses = [];
    for (let id = 100; id < 105; id += 1) responses.push(await get(`/api/agents/${id}`, `203.0.113.${id}`));
    expect(responses.map((item) => item.status)).toEqual([200, 200, 200, 503, 503]);
    expect(responses[3]).toMatchObject({ body: { code: 'RATE_LIMITED', message: expect.any(String) } });
    expect(Number(responses[3]!.headers['retry-after'])).toBeGreaterThan(0);
  });
  it('shares one set of reads between simultaneous visitors to an agent', async () => {
    const fake = spammed(3);
    const { get } = await api(fake);
    const before = mirrorCalls(fake);
    const visits = await Promise.all(Array.from({ length: 8 }, () => get('/api/agents/9')));
    expect(visits.map((item) => item.status)).toEqual(Array(8).fill(200));
    expect(mirrorCalls(fake) - before).toBe(3);
  });
  it('caps the reads one request can cause, however many reviews the agent has', async () => {
    const fake = spammed(100);
    const { get } = await api(fake);
    const before = mirrorCalls(fake);
    const { status, body } = await get('/api/agents/9');
    expect(status).toBe(200);
    expect(mirrorCalls(fake) - before).toBeLessThanOrEqual(10);
    expect(body.reviews.length).toBeLessThanOrEqual(10);
  });
  it('fills the remaining reviews in over later syncs, a capped number at a time', async () => {
    const fake = spammed(25);
    const { get, runtime } = await api(fake);
    await get('/api/agents/9');
    const before = mirrorCalls(fake);
    await runtime.sync();
    const perSync = fake.calls.slice(before).filter((call) => call.includes('/messages/')).length;
    expect(perSync).toBeLessThanOrEqual(10);
    await runtime.sync();
    expect((await get('/api/agents/9')).body.reviews).toHaveLength(25);
  });
  it('does not let a heavily reviewed agent someone visited hold the epoch up', async () => {
    const fake = spammed(100);
    fake.consensus = ts(BASE + EPOCH + 5);
    const runtime = runtimeFor(fake);
    const publisher = new RecordingPublisher(fake);
    const loop = await loopFor(runtime, publisher);
    await loop.tick();
    runtime.store.trackAgent('9', 10);
    const before = mirrorCalls(fake);
    await loop.tick();
    expect(fake.calls.slice(before).filter((call) => call.includes('/messages/')).length).toBeLessThanOrEqual(10);
    expect(publisher.published.some((message) => message.includes('"epoch"'))).toBe(true);
  });
  it('keeps the set of visited agents bounded, newest first', async () => {
    const fake = strangers(4);
    const { get, runtime } = await api(fake, { deps: { maxTrackedAgents: 2 } });
    for (let id = 100; id < 104; id += 1) expect((await get(`/api/agents/${id}`)).status).toBe(200);
    expect(runtime.store.trackedAgents().sort()).toEqual(['102', '103']);
    expect(runtime.view()!.result.agents.map((agent) => agent.agentId)).not.toContain('100');
  });
  it('re-serves an agent that fell out of the bound from cached facts', async () => {
    const fake = spammed(2);
    fake.logs.get(IDENTITY)!.push(...mint(101n, STRANGER, BASE - 690, 'Other'));
    const { get, runtime } = await api(fake, { deps: { maxTrackedAgents: 1 } });
    await get('/api/agents/9');
    await get('/api/agents/101');
    expect(runtime.store.trackedAgents()).toEqual(['101']);
    const before = mirrorCalls(fake);
    expect((await get('/api/agents/9')).body.reviews).toHaveLength(2);
    expect(mirrorCalls(fake)).toBe(before);
  });
  it('answers CHAIN_ERROR when the lookup cannot reach the mirror, and frees its slot', async () => {
    const fake = spammed(2);
    const { get } = await api(fake, { rateLimits: { agentLookupTotal: { max: 100, timeWindow: 60_000 } } });
    fake.failing = true;
    // More failures than the gate has slots, so one leaked per failure would end in a 503.
    for (let i = 0; i < 3; i += 1) {
      expect(await get('/api/agents/9')).toMatchObject({ status: 502, body: { code: 'CHAIN_ERROR' } });
    }
    fake.failing = false;
    expect((await get('/api/agents/9')).status).toBe(200);
  });
});

describe('agents linked with a grant key', () => {
  const AGENT = addr(0xc5);
  const GRANT_KEY = addr(0x6a);
  const FAR_FUTURE = BigInt(BASE + 90 * 86_400);

  function withGrantAgent(fake = seeded(), expiresAt = FAR_FUTURE): FakeMirror {
    fake.addAccount(AGENT);
    fake.logs.get(IDENTITY)!.push(...mint(5n, AGENT, BASE - 700, 'Headless Bot'));
    fake.logs.get(REGISTRY)!.push(
      registryLog('GrantAuthorized', { creator: CREATOR_A, grantKey: GRANT_KEY, expiresAt, maxAgents: 3 }, ts(BASE - 800)),
      registryLog('CredentialIssued', { holder: AGENT, serial: 4n }, ts(BASE - 690)),
      registryLog('AgentLinked', { agentId: 5n, creator: CREATOR_A, agentWallet: AGENT, serial: 4n }, ts(BASE - 690)),
      registryLog('AgentLinkedByGrant', { agentId: 5n, creator: CREATOR_A, grantKey: GRANT_KEY, owner: AGENT }, ts(BASE - 690)),
    );
    return fake;
  }

  it('is human-backed and active while the agent keeps its own NFT', async () => {
    const { get } = await api(withGrantAgent());
    expect((await get('/api/agents/5')).body).toMatchObject({
      creator: CREATOR_A,
      humanBacked: true,
      status: 'active',
      operatorChanged: false,
    });
  });

  it('is operator-changed and no longer human-backed once the NFT moves', async () => {
    const fake = withGrantAgent();
    fake.logs.get(IDENTITY)!.push(identityLog('Transfer', { from: AGENT, to: STRANGER, tokenId: 5n }, ts(BASE + 1)));
    const { get } = await api(fake);
    expect((await get('/api/agents/5')).body).toMatchObject({ humanBacked: false, status: 'operator-changed' });
  });

  it('is compromised after the creator reports it', async () => {
    const fake = withGrantAgent();
    fake.logs.get(REGISTRY)!.push(registryLog('AgentCompromised', { agentId: 5n, creator: CREATOR_A, timestamp: BigInt(BASE + 2) }, ts(BASE + 2)));
    const { get } = await api(fake);
    expect((await get('/api/agents/5')).body).toMatchObject({ humanBacked: false, status: 'compromised' });
  });

  it('lists a creator’s grants with what each one linked', async () => {
    const { get } = await api(withGrantAgent());
    const { status, body } = await get(`/api/creators/${CREATOR_A}/grants`);
    expect(status).toBe(200);
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]).toMatchObject({
      grantKey: GRANT_KEY,
      creator: CREATOR_A,
      maxAgents: 3,
      used: 1,
      revoked: false,
      expired: false,
    });
    expect(body.grants[0].agents.map((agent: { agentId: string }) => agent.agentId)).toEqual(['5']);
    expect(body.grants[0].expiresAt).toBe(new Date(Number(FAR_FUTURE) * 1000).toISOString());
  });

  it('shows another creator no grants, and a revoked or expired one as such', async () => {
    const fake = withGrantAgent(seeded(), BigInt(BASE - 100));
    fake.logs.get(REGISTRY)!.push(registryLog('GrantRevoked', { creator: CREATOR_A, grantKey: GRANT_KEY }, ts(BASE + 5)));
    const { get } = await api(fake);
    expect((await get(`/api/creators/${CREATOR_B}/grants`)).body.grants).toEqual([]);
    expect((await get(`/api/creators/${CREATOR_A}/grants`)).body.grants[0]).toMatchObject({ revoked: true, expired: true, used: 1 });
  });

  it('answers 404 for an address that is not a creator address', async () => {
    const { get } = await api(withGrantAgent());
    expect((await get('/api/creators/nope/grants')).status).toBe(404);
  });
});

describe('GET /api/config', () => {
  it('tells a client which contracts to use', async () => {
    const { get } = await api();
    expect((await get('/api/config')).body).toEqual({
      network: 'hedera-testnet',
      chainId: 296,
      identityRegistry: IDENTITY,
      creatorRegistry: REGISTRY,
      credentialTokenId: '0.0.700',
      mirrorNode: 'https://mirror.test',
    });
  });
});
