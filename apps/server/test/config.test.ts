import { PrivateKey } from '@hashgraph/sdk';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadHederaConfig } from '../src/config.ts';

const OPERATOR_KEY = `0x${'11'.repeat(32)}`;
const VERIFIER_KEY = '22'.repeat(32);
const RP_SIGNING_KEY = `0x${'33'.repeat(32)}`;

const env = (overrides: Record<string, string | undefined> = {}) => ({
  OPERATOR_KEY,
  VERIFIER_KEY,
  RP_SIGNING_KEY,
  CREATOR_REGISTRY: '0x4444444444444444444444444444444444444444',
  REVIEWS_TOPIC_ID: '0.0.9000',
  SCORES_TOPIC_ID: '0.0.9001',
  CREDENTIAL_TOKEN_ID: '0.0.9002',
  WORLD_RP_ID: 'rp_abc123',
  WORLD_ENVIRONMENT: 'staging',
  WORLD_PROTOCOL_VERSION: '4.0',
  ...overrides,
});

const failure = (input: Record<string, string | undefined>) => {
  try {
    loadConfig(input);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).message;
  }
  throw new Error('expected loadConfig to throw');
};

describe('loadConfig', () => {
  it('applies defaults and normalises keys', () => {
    const config = loadConfig(env());
    expect(config.port).toBe(4000);
    expect(config.verifierKey).toBe(`0x${VERIFIER_KEY}`);
    expect(config.rpcUrl).toBe('https://testnet.hashio.io/api');
    expect(config.world.action).toBe('agent-creator-v1');
    expect(config.world.apiBase).toBe('https://developer.world.org');
  });

  it('lists every missing variable by name', () => {
    const message = failure({});
    for (const name of [
      'OPERATOR_KEY',
      'VERIFIER_KEY',
      'RP_SIGNING_KEY',
      'CREATOR_REGISTRY',
      'REVIEWS_TOPIC_ID',
      'SCORES_TOPIC_ID',
      'CREDENTIAL_TOKEN_ID',
      'WORLD_RP_ID',
      'WORLD_ENVIRONMENT',
      'WORLD_PROTOCOL_VERSION',
    ]) {
      expect(message).toContain(name);
    }
  });

  it('treats a blank value, as in a copied .env.example, as missing', () => {
    expect(failure(env({ CREATOR_REGISTRY: '' }))).toContain('missing: CREATOR_REGISTRY');
  });

  it('names an invalid variable without echoing its value', () => {
    const secret = 'not-a-real-key-but-pretend-it-is-secret';
    const message = failure(env({ VERIFIER_KEY: secret, OPERATOR_KEY: secret }));

    expect(message).toContain('invalid: ');
    expect(message).toContain('VERIFIER_KEY');
    expect(message).toContain('OPERATOR_KEY');
    expect(message).not.toContain(secret);
  });

  it('requires an explicit World environment and protocol, with no default', () => {
    expect(failure(env({ WORLD_ENVIRONMENT: undefined }))).toContain('WORLD_ENVIRONMENT');
    expect(failure(env({ WORLD_PROTOCOL_VERSION: undefined }))).toContain('WORLD_PROTOCOL_VERSION');
  });
});

describe('TRUST_PROXY', () => {
  it('defaults to trusting no proxy', () => {
    expect(loadConfig(env()).trustProxy).toEqual([]);
  });

  it('takes a list of IPs and CIDRs', () => {
    const config = loadConfig(env({ TRUST_PROXY: '127.0.0.1, 10.0.0.0/8,::1,fd00::/8' }));
    expect(config.trustProxy).toEqual(['127.0.0.1', '10.0.0.0/8', '::1', 'fd00::/8']);
  });

  it.each([
    ['the old boolean', 'true'],
    ['the other old boolean', 'false'],
    ['a hop count, which Fastify ignores', '1'],
    ['a prefix that trusts every peer', '0.0.0.0/0'],
    ['an IPv6 prefix that trusts every peer', '::/0'],
    ['an IPv4 prefix out of range', '10.0.0.0/33'],
    ['a prefix that is not a number', '10.0.0.0/x'],
    ['a name', 'ngrok'],
    ['one bad entry in a list', '127.0.0.1,nope'],
  ])('rejects %s', (_name, TRUST_PROXY) => {
    expect(failure(env({ TRUST_PROXY }))).toContain('invalid: TRUST_PROXY');
  });
});

describe('review budget', () => {
  it('has a default, and can be set', () => {
    expect(loadConfig(env()).reviewBudget).toEqual({ maxPerHour: 500, maxConcurrent: 4 });
    expect(
      loadConfig(env({ REVIEW_MAX_PER_HOUR: '50', REVIEW_MAX_CONCURRENT: '2' })).reviewBudget,
    ).toEqual({ maxPerHour: 50, maxConcurrent: 2 });
  });

  it.each(['0', '-1', 'lots'])('rejects %s', (value) => {
    expect(failure(env({ REVIEW_MAX_PER_HOUR: value }))).toContain('REVIEW_MAX_PER_HOUR');
    expect(failure(env({ REVIEW_MAX_CONCURRENT: value }))).toContain('REVIEW_MAX_CONCURRENT');
  });
});

describe('WORLD_RP_ID', () => {
  it.each(['rp_abc123', 'rp_0000000000000001', 'rp_ABCDEF'])('accepts %s', (WORLD_RP_ID) => {
    expect(loadConfig(env({ WORLD_RP_ID })).world.rpId).toBe(WORLD_RP_ID);
  });

  it.each([
    ['an app ID', 'app_abc123'],
    ['non-hex characters', 'rp_xyz'],
    ['more than 64 bits', 'rp_00000000000000001'],
    ['no digits', 'rp_'],
  ])('rejects %s, which IDKit would refuse in the browser', (_name, WORLD_RP_ID) => {
    expect(failure(env({ WORLD_RP_ID }))).toContain('invalid: WORLD_RP_ID');
  });
});

describe('private keys', () => {
  const N = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';

  it.each([
    ['zero', '00'.repeat(32)],
    ['the curve order', N],
    ['above the curve order', 'ff'.repeat(32)],
  ])('rejects %s by name, without printing it', (_name, value) => {
    for (const name of ['VERIFIER_KEY', 'RP_SIGNING_KEY', 'OPERATOR_KEY']) {
      const message = failure(env({ [name]: value }));
      expect(message).toBe(`Server configuration error. invalid: ${name}`);
    }
  });
});

describe('loadHederaConfig', () => {
  it('needs only the operator key, so topics can be created before REVIEWS_TOPIC_ID exists', () => {
    expect(loadHederaConfig({ OPERATOR_KEY }).mirrorNode).toBe(
      'https://testnet.mirrornode.hedera.com',
    );
  });

  it('accepts the key with or without 0x', () => {
    expect(() => loadHederaConfig({ OPERATOR_KEY: '11'.repeat(32) })).not.toThrow();
  });

  it('accepts a secp256k1 DER key and keeps it usable', () => {
    const key = PrivateKey.generateECDSA();
    for (const OPERATOR_KEY of [key.toStringDer(), `0x${key.toStringDer()}`]) {
      const { operatorKey } = loadHederaConfig({ OPERATOR_KEY });
      expect(PrivateKey.fromStringECDSA(operatorKey).toStringRaw()).toBe(key.toStringRaw());
    }
  });

  it('rejects an ED25519 DER key, which the SDK would silently misread', () => {
    const OPERATOR_KEY = PrivateKey.generateED25519().toStringDer();
    expect(() => PrivateKey.fromStringECDSA(OPERATOR_KEY)).not.toThrow();
    expect(() => loadHederaConfig({ OPERATOR_KEY })).toThrow(ConfigError);
  });

  it('rejects a key with trailing junk, which the SDK would silently drop', () => {
    const OPERATOR_KEY = `${PrivateKey.generateECDSA().toStringRaw()}zz`;
    expect(() => PrivateKey.fromStringECDSA(OPERATOR_KEY)).not.toThrow();
    expect(() => loadHederaConfig({ OPERATOR_KEY })).toThrow(ConfigError);
  });
});
