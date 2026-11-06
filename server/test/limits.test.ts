import { describe, expect, it } from 'vitest';
import { harness } from './helpers.ts';
import { createLookupGate, createPublishGate } from '../src/routes/rateLimits.ts';
import { ApiHttpError } from '../src/errors.ts';
import { MirrorClient } from '../src/indexer/mirror.ts';
import { ScorerRuntime } from '../src/indexer/runtime.ts';
import { loadScorerSettings } from '../src/indexer/settings.ts';
import { Store } from '../src/indexer/store.ts';

const LIMIT = { max: 3, timeWindow: 60_000 };
const NGROK_AGENT = '127.0.0.1';

const sign = (h: Awaited<ReturnType<typeof harness>>, remoteAddress: string, forwardedFor?: string) =>
  h.app.inject({
    method: 'POST',
    url: '/api/rp-signature',
    remoteAddress,
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  });

const proxied = () =>
  harness({ trustProxy: [NGROK_AGENT], rateLimits: { rpSignatureByIp: LIMIT } });

describe('rate limits behind a proxy', () => {
  it('a spoofed leftmost X-Forwarded-For entry does not escape the IP limit', async () => {
    const h = await proxied();
    const codes = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await sign(h, NGROK_AGENT, `10.9.0.${i}, 203.0.113.7`)).statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429, 429]);
  });

  it('a junk leftmost entry does not escape it either', async () => {
    const h = await proxied();
    const codes = [];
    for (const junk of ['not-an-ip', 'x'.repeat(5000), '', '::', 'also,junk', '1.1.1.1']) {
      codes.push((await sign(h, NGROK_AGENT, `${junk}, 203.0.113.7`)).statusCode);
    }
    expect(codes.filter((code) => code === 200)).toHaveLength(3);
  });

  it('clients behind the proxy get separate buckets, so one cannot block the rest', async () => {
    const h = await proxied();
    for (let i = 0; i < 4; i++) await sign(h, NGROK_AGENT, '203.0.113.7');
    expect((await sign(h, NGROK_AGENT, '203.0.113.7')).statusCode).toBe(429);
    expect((await sign(h, NGROK_AGENT, '203.0.113.8')).statusCode).toBe(200);
  });

  it('a peer that is not the proxy cannot set its IP with the header', async () => {
    const h = await proxied();
    const codes = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await sign(h, '198.51.100.9', `10.9.0.${i}`)).statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429, 429]);
  });

  it('with no proxy configured the header is ignored', async () => {
    const h = await harness({ rateLimits: { rpSignatureByIp: LIMIT } });
    const codes = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await sign(h, '198.51.100.9', `10.9.0.${i}`)).statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429, 429]);
  });
});

describe('rate limits over a real socket', () => {
  it('reads the client from the proxy-appended entry, whatever the client sent', async () => {
    const h = await proxied();
    const url = await h.app.listen({ port: 0, host: NGROK_AGENT });
    const send = async (forwardedFor: string) =>
      (
        await fetch(`${url}/api/rp-signature`, {
          method: 'POST',
          headers: { 'x-forwarded-for': forwardedFor },
        })
      ).status;

    try {
      const spoofed = [];
      for (let i = 0; i < 6; i++) spoofed.push(await send(`10.9.0.${i}, 203.0.113.7`));
      expect(spoofed).toEqual([200, 200, 200, 429, 429, 429]);
      expect(await send('203.0.113.8')).toBe(200);
    } finally {
      await h.app.close();
    }
  });
});

describe('read routes through buildApp', () => {
  const scorer = () =>
    new ScorerRuntime({
      settings: loadScorerSettings({}),
      store: new Store(':memory:'),
      mirror: new MirrorClient({ baseUrl: 'https://mirror.test' }),
    });

  it('applies the configured limits, behind the same proxy rules as the write routes', async () => {
    const h = await harness({
      readRoutes: true,
      scorer: scorer(),
      trustProxy: [NGROK_AGENT],
      rateLimits: { agentListByIp: LIMIT },
    });
    const list = (forwardedFor: string) =>
      h.app.inject({
        method: 'GET',
        url: '/api/agents',
        remoteAddress: NGROK_AGENT,
        headers: { 'x-forwarded-for': forwardedFor },
      });

    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await list(`10.9.0.${i}, 203.0.113.7`)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    expect((await list('203.0.113.8')).statusCode).toBe(200);
  });
});

describe('createLookupGate', () => {
  it('refuses with a 503 once the window is spent, and refills', () => {
    let now = 0;
    const gate = createLookupGate({ max: 1, timeWindow: 60_000 }, () => now);
    gate.acquire()();
    let refused: unknown;
    try {
      gate.acquire();
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(ApiHttpError);
    expect(refused).toMatchObject({ statusCode: 503, code: 'RATE_LIMITED', retryAfterSeconds: 60 });
    now = 60_000;
    expect(() => gate.acquire()).not.toThrow();
  });

  it('allows two at once, and a third after one ends', () => {
    const gate = createLookupGate({ max: 100, timeWindow: 60_000 });
    const first = gate.acquire();
    gate.acquire();
    expect(() => gate.acquire()).toThrow(ApiHttpError);
    first();
    expect(() => gate.acquire()).not.toThrow();
  });
});

describe('createPublishGate', () => {
  const refused = (acquire: () => unknown) => {
    try {
      acquire();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiHttpError);
      return err as ApiHttpError;
    }
    throw new Error('expected the gate to refuse');
  };

  it('refuses past the hourly budget, and says when to come back', () => {
    let now = 0;
    const gate = createPublishGate({ maxPerHour: 2, maxConcurrent: 10 }, () => now);
    gate.acquire()();
    gate.acquire()();

    now = 3_590_000;
    const err = refused(gate.acquire);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterSeconds).toBe(10);
  });

  it('starts a new budget once the hour is over', () => {
    let now = 0;
    const gate = createPublishGate({ maxPerHour: 1, maxConcurrent: 10 }, () => now);
    gate.acquire()();
    refused(gate.acquire);

    now = 3_600_000;
    expect(() => gate.acquire()).not.toThrow();
  });

  it('caps concurrent submits, and frees the slot on release', () => {
    const gate = createPublishGate({ maxPerHour: 100, maxConcurrent: 2 });
    const first = gate.acquire();
    gate.acquire();
    expect(refused(gate.acquire).statusCode).toBe(503);

    first();
    expect(() => gate.acquire()).not.toThrow();
  });

  it('a refused attempt does not use up the budget', () => {
    const gate = createPublishGate({ maxPerHour: 2, maxConcurrent: 1 });
    const held = gate.acquire();
    refused(gate.acquire);
    refused(gate.acquire);
    held();
    expect(() => gate.acquire()).not.toThrow();
  });
});
