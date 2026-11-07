import { describe, expect, it } from 'vitest';
import { Client, PrivateKey } from '@hashgraph/sdk';
import { keccak256, type Address } from 'viem';
import { buildTopicMessage, operatorEvmAddress, resolveOperatorId } from '../src/hedera.ts';
import { MAX_AGENT_URI_BYTES } from '../src/routes/agentFile.ts';
import { serializeReviewFile, type ReviewFile } from '@reputed/shared';
import { MAX_REVIEW_FILE_BYTES, reviewFile } from '../src/routes/reviewFile.ts';
import { CREATOR_A, CREATOR_B, IDENTITY, JUNK_SIGNATURE, WALLET_U, harness, signBytes } from './helpers.ts';

const agentFile = (overrides: object = {}) => ({
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'TradeBot A1',
  description: 'Settles trades.',
  image: 'https://example.com/a1.png',
  services: [{ name: 'A2A', endpoint: 'https://a1.example/agent-card.json', version: '0.3.0' }],
  x402Support: false,
  active: true,
  registrations: [],
  supportedTrust: ['reputation'],
  ...overrides,
});

const post = async (url: string, payload: object, h?: Awaited<ReturnType<typeof harness>>) => {
  const target = h ?? (await harness());
  return target.app.inject({ method: 'POST', url, payload });
};

describe('POST /api/agent-file', () => {
  it('returns a data: URI that decodes to the file, with the keccak-256 of those bytes', async () => {
    const res = await post('/api/agent-file', agentFile());
    expect(res.statusCode).toBe(200);

    const { uri, hash } = res.json();
    expect(uri.startsWith('data:application/json;base64,')).toBe(true);
    const bytes = Buffer.from(uri.split(',')[1], 'base64');
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(agentFile());
    expect(hash).toBe(keccak256(bytes));
  });

  it('keeps fields the spec allows agents to add', async () => {
    const res = await post('/api/agent-file', agentFile({ tags: ['trading'] }));
    const decoded = Buffer.from(res.json().uri.split(',')[1], 'base64').toString('utf8');
    expect(JSON.parse(decoded).tags).toEqual(['trading']);
  });

  it('accepts the registrations entry written at onboarding step 4', async () => {
    const res = await post(
      '/api/agent-file',
      agentFile({ registrations: [{ agentId: 22, agentRegistry: `eip155:296:${IDENTITY}` }] }),
    );
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['wrong type URL', { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v2' }, 'type'],
    ['empty name', { name: '' }, 'name'],
    ['no services', { services: [] }, 'services'],
    ['service without endpoint', { services: [{ name: 'MCP' }] }, 'services.0.endpoint'],
    ['x402Support not boolean', { x402Support: 'no' }, 'x402Support'],
    ['active missing', { active: undefined }, 'active'],
    ['bad registration', { registrations: [{ agentId: 1, agentRegistry: 'nope' }] }, 'registrations.0.agentRegistry'],
  ])('rejects %s and names the field', async (_name, overrides, field) => {
    const res = await post('/api/agent-file', agentFile(overrides));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
    expect(res.json().message).toContain(field);
  });

  it('rejects a file whose URI would be too costly to store on-chain', async () => {
    const res = await post(
      '/api/agent-file',
      agentFile({ image: `data:image/png;base64,${'A'.repeat(MAX_AGENT_URI_BYTES)}` }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/too large/);
  });

  it('is rate limited', async () => {
    const h = await harness({ rateLimits: { agentFileByIp: { max: 1, timeWindow: 60_000 } } });
    await post('/api/agent-file', agentFile(), h);
    const res = await post('/api/agent-file', agentFile(), h);
    expect(res.json().code).toBe('RATE_LIMITED');
  });
});

const CLIENT = CREATOR_B;

const review = (overrides: object = {}) => ({
  agentRegistry: `eip155:296:${IDENTITY}`,
  agentId: '157',
  clientAddress: `eip155:296:${CLIENT}`,
  createdAt: '2026-11-06T12:00:00Z',
  value: 90,
  valueDecimals: 0,
  tag1: 'quality',
  tag2: 'accuracy',
  endpoint: 'https://a1.example/mcp',
  comment: 'Settled on time.',
  proofOfPayment: '0.0.1234@1793960511.841191137',
  ...overrides,
});

/** The body a client sends: the file plus clientAddress's signature over its bytes. */
const signed = async (overrides: object = {}, signer: Address = CLIENT) => {
  const body = review(overrides);
  const bytes = serializeReviewFile(reviewFile.parse(body));
  return { ...body, signature: await signBytes(signer, bytes) };
};

describe('POST /api/review-file', () => {
  it('posts the file and returns the HCS URI from the receipt', async () => {
    const h = await harness();
    const res = await post('/api/review-file', await signed(), h);

    expect(res.statusCode).toBe(200);
    expect(res.json().feedbackUri).toBe('hcs://0.0.9000/1');
    expect(h.publisher.messages).toHaveLength(1);
  });

  it('T4.2 logic: feedbackHash is the keccak-256 of the exact bytes posted', async () => {
    const h = await harness();
    const res = await post('/api/review-file', await signed(), h);
    const posted = h.publisher.messages[0]!;

    expect(res.json().feedbackHash).toBe(keccak256(posted));
    // Mirror Node returns the message base64-encoded.
    const fromMirror = Buffer.from(Buffer.from(posted).toString('base64'), 'base64');
    expect(keccak256(fromMirror)).toBe(res.json().feedbackHash);
  });

  it('keeps multi-byte comments intact and hashes their UTF-8 bytes', async () => {
    const h = await harness();
    const res = await post('/api/review-file', await signed({ comment: 'Très bien ✓' }), h);
    const posted = h.publisher.messages[0]!;

    expect(JSON.parse(Buffer.from(posted).toString('utf8')).comment).toBe('Très bien ✓');
    expect(res.json().feedbackHash).toBe(keccak256(posted));
  });

  it('writes the same bytes for the same review, whatever the input key order', async () => {
    const h = await harness();
    const body = await signed();
    const { value, tag1, ...rest } = body;
    await post('/api/review-file', body, h);
    await post('/api/review-file', { tag1, ...rest, value }, h);
    expect(h.publisher.messages[0]).toEqual(h.publisher.messages[1]);
  });

  it('stores the file in the spec format', async () => {
    const h = await harness();
    await post('/api/review-file', await signed(), h);
    const file = JSON.parse(Buffer.from(h.publisher.messages[0]!).toString('utf8'));

    expect(file.agentId).toBe(157);
    expect(file.clientAddress).toBe(`eip155:296:${CLIENT}`);
    expect(file.valueDecimals).toBe(0);
    expect(file.signature).toBeUndefined();
  });

  // Pinned: this is what a wallet signs, so the web app and SDK must produce it too.
  it('serialises a review to exactly these bytes', () => {
    const file = reviewFile.parse(
      review({ clientAddress: `eip155:296:${CLIENT.toLowerCase()}`, agentId: '157' }),
    );
    expect(Buffer.from(serializeReviewFile(file)).toString('utf8')).toBe(
      `{"agentRegistry":"eip155:296:${IDENTITY}","agentId":157,"clientAddress":"eip155:296:${CLIENT}",` +
        '"createdAt":"2026-11-06T12:00:00Z","value":90,"valueDecimals":0,"tag1":"quality",' +
        '"tag2":"accuracy","endpoint":"https://a1.example/mcp","comment":"Settled on time.",' +
        '"proofOfPayment":"0.0.1234@1793960511.841191137"}',
    );
  });

  // The web app signs before the server normalises anything, so the shared function has to as well.
  it('gives the same bytes for lower-case addresses as the server does after parsing', () => {
    const raw = review({
      agentRegistry: `eip155:296:${IDENTITY.toLowerCase()}`,
      clientAddress: `eip155:296:${CLIENT.toLowerCase()}`,
    });
    expect(serializeReviewFile(raw as ReviewFile)).toEqual(serializeReviewFile(reviewFile.parse(raw)));
  });

  it('T4.5/T4.6 logic: accepts a review with no payment or a made-up one', async () => {
    expect(
      (await post('/api/review-file', await signed({ proofOfPayment: undefined }))).statusCode,
    ).toBe(200);
    expect(
      (await post('/api/review-file', await signed({ proofOfPayment: 'made-up-payment' })))
        .statusCode,
    ).toBe(200);
  });

  it('accepts a 1023-byte file and rejects a 1024-byte one', async () => {
    const h = await harness();
    await post('/api/review-file', await signed({ comment: '' }), h);
    const emptyCommentLength = h.publisher.messages[0]!.length;

    // Three-byte characters reach the limit inside the 512-character comment cap.
    const reviewOfSize = (bytes: number) => {
      const fill = bytes - emptyCommentLength;
      return signed({ comment: '✓'.repeat(Math.floor(fill / 3)) + 'x'.repeat(fill % 3) });
    };

    const under = await post('/api/review-file', await reviewOfSize(1023), h);
    expect(under.statusCode).toBe(200);
    expect(h.publisher.messages[1]).toHaveLength(1023);

    const over = await post('/api/review-file', await reviewOfSize(MAX_REVIEW_FILE_BYTES), h);
    expect(over.statusCode).toBe(400);
    expect(over.json().code).toBe('BAD_REQUEST');
    expect(over.json().message).toMatch(/under 1024/);
    expect(h.publisher.messages).toHaveLength(2);
  });

  it.each([
    ['another registry', { agentRegistry: `eip155:296:${CLIENT}` }, 'agentRegistry'],
    ['another chain', { agentRegistry: `eip155:1:${IDENTITY}` }, 'agentRegistry'],
    ['a plain client address', { clientAddress: CLIENT }, 'clientAddress'],
    ['a bad client address', { clientAddress: 'eip155:296:0x12' }, 'clientAddress'],
    ['a negative agent ID', { agentId: -1 }, 'agentId'],
    ['a non-numeric agent ID', { agentId: 'abc' }, 'agentId'],
    ['a value above 100', { value: 101 }, 'value'],
    ['a fractional value', { value: 90.5 }, 'value'],
    ['non-zero decimals', { valueDecimals: 2 }, 'valueDecimals'],
    ['an unknown tag1', { tag1: 'praise' }, 'tag1'],
    ['an invalid date', { createdAt: 'yesterday' }, 'createdAt'],
    ['an empty endpoint', { endpoint: '' }, 'endpoint'],
    ['an unknown field', { secret: 'x' }, 'body'],
  ])('rejects %s without posting', async (_name, overrides, field) => {
    const h = await harness();
    const res = await post(
      '/api/review-file',
      { ...review(overrides), signature: JUNK_SIGNATURE },
      h,
    );

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
    expect(res.json().message).toContain(field);
    expect(h.publisher.messages).toHaveLength(0);
  });

  it('an HCS failure is CHAIN_ERROR', async () => {
    const h = await harness();
    h.publisher.fail = true;
    const res = await post('/api/review-file', await signed(), h);

    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('CHAIN_ERROR');
  });

  it('limits by IP across client addresses', async () => {
    const h = await harness({ rateLimits: { reviewFileByIp: { max: 1, timeWindow: 60_000 } } });
    await post('/api/review-file', await signed(), h);
    const res = await post(
      '/api/review-file',
      await signed({ clientAddress: `eip155:296:${WALLET_U}` }, WALLET_U),
      h,
    );
    expect(res.json().code).toBe('RATE_LIMITED');
  });

  it('limits by client address across IPs', async () => {
    const h = await harness({ rateLimits: { reviewFileByClient: { max: 1, timeWindow: 60_000 } } });
    const payload = await signed();
    const send = (remoteAddress: string) =>
      h.app.inject({ method: 'POST', url: '/api/review-file', remoteAddress, payload });
    await send('10.0.0.1');
    const res = await send('10.0.0.2');
    expect(res.json().code).toBe('RATE_LIMITED');
  });
});

describe('POST /api/review-file: only the client can post as the client', () => {
  it.each([
    ['a missing signature', () => review()],
    ['a malformed signature', () => ({ ...review(), signature: '0x1234' })],
    ['a signature that recovers to nothing', () => ({ ...review(), signature: JUNK_SIGNATURE })],
    ['another wallet signing for the client', () => signed({}, WALLET_U)],
  ])('rejects %s without posting', async (_name, body) => {
    const h = await harness();
    const res = await post('/api/review-file', await body(), h);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
    expect(res.json().message).toContain('signature');
    expect(h.publisher.messages).toHaveLength(0);
  });

  it('rejects a signed review whose content was changed afterwards', async () => {
    const h = await harness();
    const res = await post('/api/review-file', { ...(await signed()), value: 0 }, h);

    expect(res.statusCode).toBe(400);
    expect(h.publisher.messages).toHaveLength(0);
  });

  it('accepts a client that sends its address in lowercase', async () => {
    const h = await harness();
    const lower = `eip155:296:${CLIENT.toLowerCase()}`;
    const res = await post('/api/review-file', await signed({ clientAddress: lower }), h);
    expect(res.statusCode).toBe(200);
  });

  it('nobody can use up a client limit by naming it: the client still gets through', async () => {
    const h = await harness({ rateLimits: { reviewFileByClient: { max: 1, timeWindow: 60_000 } } });
    const send = (payload: object, remoteAddress: string) =>
      h.app.inject({ method: 'POST', url: '/api/review-file', remoteAddress, payload });

    const forged = await signed({}, WALLET_U);
    for (let i = 0; i < 5; i++) {
      expect((await send(review(), '10.0.0.66')).statusCode).toBe(400);
      expect((await send(forged, '10.0.0.66')).statusCode).toBe(400);
    }
    expect((await send(await signed(), '10.0.0.7')).statusCode).toBe(200);
  });
});

describe('POST /api/review-file: operator budget', () => {
  const send = (h: Awaited<ReturnType<typeof harness>>, payload: object) =>
    h.app.inject({ method: 'POST', url: '/api/review-file', payload });

  it('stops paying past the hourly budget, even with a fresh wallet per review', async () => {
    const h = await harness({ reviewBudget: { maxPerHour: 2, maxConcurrent: 10 } });
    const wallets = [CLIENT, WALLET_U, CREATOR_A];
    const results = [];
    for (const wallet of wallets) {
      results.push(await send(h, await signed({ clientAddress: `eip155:296:${wallet}` }, wallet)));
    }

    expect(results.map((res) => res.statusCode)).toEqual([200, 200, 503]);
    expect(results[2]!.json().code).toBe('RATE_LIMITED');
    expect(Number(results[2]!.headers['retry-after'])).toBeGreaterThan(0);
    expect(h.publisher.messages).toHaveLength(2);
  });

  it('caps concurrent submits, and frees the slot when one ends', async () => {
    const h = await harness({ reviewBudget: { maxPerHour: 100, maxConcurrent: 1 } });
    const publish = h.publisher.publish.bind(h.publisher);
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    let reached!: () => void;
    const submitting = new Promise<void>((resolve) => (reached = resolve));
    h.publisher.publish = async (message) => {
      reached();
      await held;
      return publish(message);
    };

    const body = await signed();
    const first = send(h, body);
    await submitting;
    const second = await send(h, body);
    expect(second.statusCode).toBe(503);

    finish();
    expect((await first).statusCode).toBe(200);
    expect((await send(h, body)).statusCode).toBe(200);
  });

  it('a failed submit frees its slot', async () => {
    const h = await harness({ reviewBudget: { maxPerHour: 100, maxConcurrent: 1 } });
    const body = await signed();
    h.publisher.fail = true;
    expect((await send(h, body)).statusCode).toBe(502);
    h.publisher.fail = false;
    expect((await send(h, body)).statusCode).toBe(200);
  });

  it('invalid requests cost no budget', async () => {
    const h = await harness({ reviewBudget: { maxPerHour: 1, maxConcurrent: 1 } });
    for (let i = 0; i < 3; i++) expect((await send(h, review())).statusCode).toBe(400);
    expect((await send(h, await signed())).statusCode).toBe(200);
  });
});

describe('Hedera helpers', () => {
  const key = PrivateKey.generateECDSA();

  it('builds a single-chunk message carrying the exact bytes', () => {
    const bytes = Buffer.from('{"value":90}', 'utf8');
    const tx = buildTopicMessage('0.0.9000', bytes);

    expect(tx.topicId?.toString()).toBe('0.0.9000');
    expect(Buffer.from(tx.getMessage()!)).toEqual(bytes);
    expect(tx.maxChunks).toBe(1);
  });

  it('the SDK refuses a message that would need a second chunk', () => {
    const client = Client.forTestnet().setOperator('0.0.1234', key);
    const tx = buildTopicMessage('0.0.9000', Buffer.alloc(MAX_REVIEW_FILE_BYTES + 1));
    expect(() => tx.freezeWith(client)).toThrow(/chunk/i);
    client.close();
  });

  it('uses OPERATOR_ID as given', async () => {
    const id = await resolveOperatorId({
      operatorKey: key.toStringRaw(),
      operatorId: '0.0.42',
      mirrorNode: 'https://mirror.test',
    });
    expect(id).toBe('0.0.42');
  });

  it('derives OPERATOR_ID from the key\'s EVM address through the Mirror Node', async () => {
    const asked: string[] = [];
    const id = await resolveOperatorId(
      { operatorKey: key.toStringRaw(), mirrorNode: 'https://mirror.test' },
      {
        transactionIdOf: async () => null,
        accountIdOf: async (address) => {
          asked.push(address);
          return '0.0.77';
        },
      },
    );
    expect(id).toBe('0.0.77');
    expect(asked).toEqual([operatorEvmAddress(key)]);
  });

  it('explains what to do when the account does not exist yet', async () => {
    await expect(
      resolveOperatorId(
        { operatorKey: key.toStringRaw(), mirrorNode: 'https://mirror.test' },
        { transactionIdOf: async () => null, accountIdOf: async () => null },
      ),
    ).rejects.toThrow(/Fund it, or set OPERATOR_ID/);
  });
});
