import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { creatorRegistryAbi, identityRegistryAbi, reputationRegistryAbi, type Address } from '@reputed/shared';
import Fastify from 'fastify';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiItem, toEventSelector, toHex, type Abi, type AbiEvent, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { registerErrorHandling } from '../errors.ts';
import { SCORING_CONFIG } from '../scoring/config.ts';
import { registerReadRoutes } from '../scoring/routes.ts';
import { createEpochLoop } from '../scoring/scheduler.ts';
import { canonicalJson } from '../scoring/snapshot.ts';
import { assembleChunks, readLatestSnapshot, type SnapshotPublisher } from '../scoring/topic.ts';
import { parseAgentProfile, loadAgentFile } from './agentFile.ts';
import { decodeLog, type MirrorLog } from './decode.ts';
import { foldEvents } from './fold.ts';
import { ingestSource } from './ingest.ts';
import { parseHcsUri } from './inputs.ts';
import { MirrorClient, MirrorError, toPaymentFact, type TopicMessage } from './mirror.ts';
import { ScorerRuntime } from './runtime.ts';
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

  fetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    this.calls.push(path + url.search);
    if (this.outageOn?.test(path)) this.failing = true;
    if (this.failing) return json({}, 503);
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
      return found ? json(found) : json({}, 404);
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
      return found ? json({ transactions: found }) : json({}, 404);
    }
    const acct = /^\/api\/v1\/accounts\/([^/]+)$/.exec(path);
    if (acct) {
      const found = this.accounts.get(acct[1]!);
      return found ? json(found) : json({}, 404);
    }
    return json({}, 404);
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

function runtimeFor(fake: FakeMirror, store = new Store(':memory:'), overrides: Partial<ScorerSettings> = {}, epochSeconds = EPOCH): ScorerRuntime {
  return new ScorerRuntime({
    store,
    settings: settings(overrides),
    mirror: new MirrorClient({ baseUrl: 'https://mirror.test', fetch: fake.fetch, sleep: async () => {} }),
    config: { ...SCORING_CONFIG, epochSeconds },
  });
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
      fetch: (async () => { if (++calls === 1) throw new TypeError('socket'); return json({}, 404); }) as typeof fetch,
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
    for (const image of ['javascript:alert(1)', 'data:text/html,x', 'data:image/svg+xml,<svg onload=alert(1)>', 'not a url']) {
      expect(parseAgentProfile(JSON.stringify({ image })).image).toBeUndefined();
    }
    for (const image of ['https://example.com/a.png', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi']) {
      expect(parseAgentProfile(JSON.stringify({ image })).image).toBe(image);
    }
  });
  it('survives junk', () => {
    expect(parseAgentProfile('not json')).toEqual({ tags: [], endpoints: {} });
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
  async function api(fake = seeded()) {
    const runtime = runtimeFor(fake);
    await runtime.sync();
    const app = Fastify();
    registerErrorHandling(app);
    registerReadRoutes(app, runtime);
    await app.ready();
    const get = async (url: string) => {
      const response = await app.inject({ method: 'GET', url });
      return { status: response.statusCode, body: response.json() };
    };
    return { app, get, runtime };
  }

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
    expect(await ids('/api/agents?humanBacked=false')).toEqual([]);
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
    expect((await get('/api/agents?humanBacked=false')).body.agents).toEqual([]);
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
    const runtime = runtimeFor(new FakeMirror());
    const app = Fastify();
    registerErrorHandling(app);
    registerReadRoutes(app, runtime);
    const response = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(response.json()).toEqual({ agents: [], stats: { agents: 0, humanBacked: 0, creators: 0, reviewsCounted: 0 } });
  });
});
