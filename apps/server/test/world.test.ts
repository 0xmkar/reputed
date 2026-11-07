import { walletBindingMessage } from '@reputed/shared';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, recoverMessageAddress, stringToBytes } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import {
  hashToField,
  rpSignatureMessage,
  signRpRequest,
  walletSignalHash,
} from '../src/world/signing.ts';
import { NONCE, WORLD, harness } from './helpers.ts';

// Test vectors from https://docs.world.org/world-id/idkit/signatures
const SIGNING_KEY = `0x${'ab'.repeat(32)}` as const;
const RANDOM = Uint8Array.from({ length: 32 }, (_, i) => i);
const SPEC_NONCE = '0x008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd';

describe('hashToField', () => {
  it.each([
    ['empty', new Uint8Array(), '0x00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4'],
    ['test_signal', stringToBytes('test_signal'), '0x00c1636e0a961a3045054c4d61374422c31a95846b8442f0927ad2ff1d6112ed'],
    ['raw bytes', Uint8Array.of(1, 2, 3), '0x00f1885eda54b7a053318cd41e2093220dab15d65381b1157a3633a83bfd5c92'],
    ['hello', stringToBytes('hello'), '0x001c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36dea'],
  ])('matches the spec vector for %s', (_name, input, expected) => {
    expect(hashToField(input)).toBe(expected);
  });
});

describe('walletSignalHash', () => {
  it('hashes the address as 20 raw bytes, as IDKit does for a 0x signal', () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    expect(walletSignalHash(wallet)).toBe(hashToField(hexToBytes(wallet)));
    expect(walletSignalHash(wallet)).not.toBe(hashToField(stringToBytes(wallet)));
  });

  it('does not depend on letter case', () => {
    const checksummed = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
    expect(walletSignalHash(checksummed)).toBe(
      walletSignalHash(checksummed.toLowerCase() as `0x${string}`),
    );
  });
});

describe('walletBindingMessage', () => {
  const wallet = '0xabcdef0123456789abcdef0123456789abcdef01';

  // Pinned: the web app builds this same text, so a change here breaks signing there.
  it('is this exact text, with a checksummed wallet and a padded nonce', () => {
    expect(walletBindingMessage(wallet, 'agent-creator-v1', '0xabc')).toBe(
      [
        'Reputed: bind this wallet to my World ID as a creator.',
        'Wallet: 0xabCDeF0123456789AbcdEf0123456789aBCDEF01',
        'Action: agent-creator-v1',
        'Nonce: 0x0000000000000000000000000000000000000000000000000000000000000abc',
      ].join('\n'),
    );
  });

  it('reads a nonce from /api/rp-signature unchanged', () => {
    expect(walletBindingMessage(wallet, 'a', NONCE).endsWith(`Nonce: ${NONCE}`)).toBe(true);
  });
});

describe('rpSignatureMessage', () => {
  it('matches the spec vector without an action', () => {
    expect(bytesToHex(rpSignatureMessage(SPEC_NONCE, 1700000000, 1700000300))).toBe(
      '0x01008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd000000006553f100000000006553f22c',
    );
  });

  it('matches the spec vector with an action', () => {
    expect(bytesToHex(rpSignatureMessage(SPEC_NONCE, 1700000000, 1700000300, 'test-action'))).toBe(
      '0x01008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd000000006553f100000000006553f22c00aa0ce59768ae5b1c52f07a9387f14f09f277422c0d2f8a268c7bad0c60a46a',
    );
  });
});

describe('signRpRequest', () => {
  it('matches the spec vector for a uniqueness proof', async () => {
    const signed = await signRpRequest({
      signingKey: SIGNING_KEY,
      action: 'test-action',
      random: RANDOM,
      nowSeconds: 1700000000,
    });
    expect(signed.nonce).toBe(SPEC_NONCE);
    expect(signed.expiresAt).toBe(1700000300);
    expect(signed.sig).toBe(
      '0x05594adb6c1495768a38d523d7d6ee6356b2c31231919198794ed022ade7d08f73753f83bd167067d99c9b969d28e9222315837c66af25867b041273a6d5056f1b',
    );
  });
});

describe('POST /api/rp-signature', () => {
  it('returns an rp_context signed by the RP key for the configured action', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'POST', url: '/api/rp-signature' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toMatchObject({
      action: WORLD.action,
      environment: 'staging',
      protocol_version: '4.0',
    });
    expect(body.rp_context.rp_id).toBe('rp_test');
    expect(body.rp_context.expires_at - body.rp_context.created_at).toBe(300);

    const signer = await recoverMessageAddress({
      message: {
        raw: rpSignatureMessage(
          body.rp_context.nonce,
          body.rp_context.created_at,
          body.rp_context.expires_at,
          WORLD.action,
        ),
      },
      signature: body.rp_context.signature,
    });
    expect(signer).toBe(privateKeyToAddress(SIGNING_KEY));
  });

  it('issues a fresh nonce each time and never returns the signing key', async () => {
    const h = await harness();
    const [a, b] = await Promise.all([
      h.app.inject({ method: 'POST', url: '/api/rp-signature' }),
      h.app.inject({ method: 'POST', url: '/api/rp-signature' }),
    ]);
    expect(a.json().rp_context.nonce).not.toBe(b.json().rp_context.nonce);
    expect(a.body).not.toContain('ab'.repeat(32));
  });

  it('is rate limited', async () => {
    const h = await harness({ rateLimits: { rpSignatureByIp: { max: 1, timeWindow: 60_000 } } });
    await h.app.inject({ method: 'POST', url: '/api/rp-signature' });
    const res = await h.app.inject({ method: 'POST', url: '/api/rp-signature' });
    expect(res.json().code).toBe('RATE_LIMITED');
  });
});
