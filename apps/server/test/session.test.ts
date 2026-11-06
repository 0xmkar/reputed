import { sessionMessage } from '@reputed/shared';
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { SESSION_TTL_SECONDS, issueSessionToken, readSessionToken } from '../src/session.ts';
import { CREATOR_A, CREATOR_B, JUNK_SIGNATURE, SESSION_SECRET, harness, signMessageAs } from './helpers.ts';

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function signIn(
  h: Awaited<ReturnType<typeof harness>>,
  wallet = CREATOR_A,
  issuedAt = nowSeconds(),
  signer = wallet,
) {
  return h.app.inject({
    method: 'POST',
    url: '/api/session',
    payload: { wallet, issuedAt, signature: await signMessageAs(signer, sessionMessage(wallet, issuedAt)) },
  });
}

describe('POST /api/session', () => {
  it('trades a wallet signature for a token that GET /api/session accepts', async () => {
    const h = await harness();
    const res = await signIn(h);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.wallet).toBe(getAddress(CREATOR_A));
    expect(body.expiresAt).toBeGreaterThan(nowSeconds() + SESSION_TTL_SECONDS - 5);

    const check = await h.app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toEqual({ wallet: getAddress(CREATOR_A), expiresAt: body.expiresAt });
  });

  it('refuses a signature from another wallet', async () => {
    const h = await harness();
    const res = await signIn(h, CREATOR_A, nowSeconds(), CREATOR_B);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('refuses a signature that recovers to nothing', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { wallet: CREATOR_A, issuedAt: nowSeconds(), signature: JUNK_SIGNATURE },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a signature that is too old or from the future', async () => {
    const h = await harness();
    expect((await signIn(h, CREATOR_A, nowSeconds() - 6 * 60)).statusCode).toBe(400);
    expect((await signIn(h, CREATOR_A, nowSeconds() + 6 * 60)).statusCode).toBe(400);
  });

  it('refuses a malformed body', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'POST', url: '/api/session', payload: { wallet: 'nope' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/session', () => {
  it('answers 401 without a token, with garbage, or with a token for another secret', async () => {
    const h = await harness();
    const foreign = issueSessionToken('another-secret-another-secret-123456', CREATOR_A, nowSeconds()).token;
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: `Bearer ${foreign}` }]) {
      const res = await h.app.inject({ method: 'GET', url: '/api/session', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('UNAUTHORIZED');
    }
  });
});

describe('session tokens', () => {
  it('expire', () => {
    const { token } = issueSessionToken(SESSION_SECRET, CREATOR_A, 1_000);
    expect(readSessionToken(SESSION_SECRET, token, 1_000 + SESSION_TTL_SECONDS - 1)?.wallet).toBe(getAddress(CREATOR_A));
    expect(readSessionToken(SESSION_SECRET, token, 1_000 + SESSION_TTL_SECONDS)).toBeNull();
  });

  it('cannot be edited to name another wallet', () => {
    const { token } = issueSessionToken(SESSION_SECRET, CREATOR_A, 1_000);
    const [, tag] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ w: getAddress(CREATOR_B), e: 9_999_999_999 })).toString('base64url');
    expect(readSessionToken(SESSION_SECRET, `${forged}.${tag}`, 1_000)).toBeNull();
  });
});
