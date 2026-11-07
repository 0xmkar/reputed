import { hashTypedData } from 'viem';
import { describe, expect, it } from 'vitest';
import { grantAddress, grantPrivateKey, linkGrantTypedData, newApiKey, parseApiKey, signLinkGrant } from '../src/grant';

// The same inputs and expected values as LinkGrantVectorTest in packages/contracts/test/LinkWithGrant.t.sol.
const KEY = 'rpk_test_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const INPUT = {
  creatorRegistry: '0x1111111111111111111111111111111111111111',
  agentId: 7n,
  owner: '0x2222222222222222222222222222222222222222',
  deadline: 1800000000n,
  chainId: 296,
} as const;

describe('API keys', () => {
  it('derives the grant address the contract test expects', () => {
    expect(grantAddress(KEY)).toBe('0xfF5eA34E2eABc2EDC7D271aD969024cF5A7bEe1B');
  });

  it('hashes LinkGrant to the digest the contract test expects', () => {
    expect(hashTypedData(linkGrantTypedData(INPUT))).toBe(
      '0x0d68a322e28c4d2ce2d2f40f3db915f14ec553846d5817dc880f43d8dff3b3e0',
    );
  });

  it('signs LinkGrant to the signature the contract test recovers', async () => {
    expect(await signLinkGrant(KEY, INPUT)).toBe(
      '0x9f62d720559fbe52333d63c710ebed028756d8d480d53556c97daa15ae33273d3e1a1589cded42ea2a8ff98de1abaa1b0c066b8108c6c80a69b041a81a60426b1b',
    );
  });

  it('round-trips a new key', () => {
    const key = newApiKey('live');
    expect(key).toMatch(/^rpk_live_[A-Za-z0-9_-]{43}$/);
    const parsed = parseApiKey(key);
    expect(parsed.environment).toBe('live');
    expect(parsed.secret).toMatch(/^0x[0-9a-f]{64}$/);
    expect(grantAddress(key)).toBe(grantAddress(key));
    expect(grantAddress(newApiKey())).not.toBe(grantAddress(key));
  });

  it('parses keys whose encoding contains underscores and dashes', () => {
    for (let i = 0; i < 200; i++) expect(() => grantAddress(newApiKey())).not.toThrow();
    // 0xfb 0xff… encodes to "-_" characters.
    const odd = `rpk_test_${'-_'.repeat(21)}-`;
    expect(parseApiKey(odd).secret).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('does not use the secret itself as the signing key', () => {
    expect(grantPrivateKey(KEY)).not.toBe(parseApiKey(KEY).secret);
  });

  it.each([
    '',
    'rpk_test_',
    'rpk_test_AAEC',
    'sk_test_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    'rpk_prod_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    'rpk_test_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8_x',
  ])('rejects %j', (bad) => {
    expect(() => parseApiKey(bad)).toThrow(/Not a Reputed API key/);
  });

  it('never echoes the key in the error', () => {
    try {
      parseApiKey('rpk_test_secretsecretsecret');
    } catch (error) {
      expect(String(error)).not.toContain('secretsecret');
    }
  });
});
