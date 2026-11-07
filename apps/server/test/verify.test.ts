import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { logReason } from '../src/errors.ts';
import {
  CREATOR_A,
  CREATOR_B,
  JUNK_SIGNATURE,
  N1,
  N2,
  NONCE,
  WALLET_U,
  WORLD,
  harness,
  idkitResult,
  jsonResponse,
  postVerify,
  walletSignatureFor,
} from './helpers.ts';

const registered = async () => {
  const h = await harness();
  const proof = idkitResult({ wallet: CREATOR_A, nullifier: N1 });
  const res = await postVerify(h.app, CREATOR_A, proof);
  expect(res.statusCode).toBe(200);
  return { ...h, proof };
};

describe('POST /api/verify: success', () => {
  it('T2.1 logic: verifies with World, registers, returns both transaction IDs', async () => {
    const h = await harness();
    const proof = idkitResult({ wallet: CREATOR_A });
    const res = await postVerify(h.app, CREATOR_A, proof);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      transactionHash: `0x${'ee'.repeat(32)}`,
      transactionId: '0.0.1234-1793960511-1',
      wallet: getAddress(CREATOR_A),
      nullifierHash: N1,
    });
    expect(h.registry.byNullifier.get(N1)).toBe(getAddress(CREATOR_A));
  });

  it('forwards the IDKit result unchanged to the v4 endpoint', async () => {
    const h = await harness();
    const proof = { ...idkitResult(), extra_field_from_a_newer_idkit: 'kept' };
    await postVerify(h.app, CREATOR_A, proof);

    expect(h.worldCalls).toHaveLength(1);
    expect(h.worldCalls[0]!.url).toBe('https://world.test/api/v4/verify/rp_test');
    expect(h.worldCalls[0]!.body).toEqual(proof);
  });

  it('accepts a legacy 3.0 Orb proof when the server is set to 3.0', async () => {
    const h = await harness({ world: { ...WORLD, protocolVersion: '3.0' } });
    const res = await postVerify(
      h.app,
      CREATOR_A,
      idkitResult({ wallet: CREATOR_A, protocolVersion: '3.0' }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('treats the wallet case-insensitively for the signal binding', async () => {
    const h = await harness();
    const res = await postVerify(
      h.app,
      CREATOR_A.toLowerCase(),
      idkitResult({ wallet: CREATOR_A }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('still returns 200 when the mirror node has not indexed the transaction', async () => {
    const h = await harness();
    const original = h.registry.registerCreator.bind(h.registry);
    h.registry.registerCreator = async (...args) => ({
      ...(await original(...args)),
      transactionId: null,
    });
    const res = await postVerify(h.app, CREATOR_A, idkitResult());
    expect(res.statusCode).toBe(200);
    expect(res.json().transactionId).toBeNull();
  });
});

describe('POST /api/verify: 409 paths', () => {
  it('T2.2: same human, second wallet returns ALREADY_REGISTERED with the existing wallet', async () => {
    const h = await registered();
    const res = await postVerify(
      h.app,
      CREATOR_B,
      idkitResult({ wallet: CREATOR_B, nullifier: N1 }),
    );

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ALREADY_REGISTERED');
    expect(res.json().message).toContain(getAddress(CREATOR_A));
    expect(h.registry.sends).toBe(1);
    expect(h.worldCalls).toHaveLength(1);
  });

  it('T2.4: replaying the exact request returns 409 and sends nothing', async () => {
    const h = await registered();
    const res = await postVerify(h.app, CREATOR_A, h.proof);

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ALREADY_REGISTERED');
    expect(h.registry.sends).toBe(1);
    expect(h.worldCalls).toHaveLength(1);
  });

  it('T2.4 under relay lag: replay is caught even while reads still show nothing', async () => {
    const h = await registered();
    h.registry.frozenReads = true;
    const res = await postVerify(h.app, CREATOR_A, h.proof);

    expect(res.statusCode).toBe(409);
    expect(h.registry.sends).toBe(1);
  });

  it('checks the contract even with no local record, as after a restart', async () => {
    const h = await harness();
    h.registry.byNullifier.set(N1, getAddress(CREATOR_A));
    const res = await postVerify(h.app, CREATOR_B, idkitResult({ wallet: CREATOR_B }));

    expect(res.json().code).toBe('ALREADY_REGISTERED');
    expect(h.worldCalls).toHaveLength(0);
  });

  it('T2.5: a second human on a taken wallet returns WALLET_TAKEN', async () => {
    const h = await registered();
    const res = await postVerify(
      h.app,
      CREATOR_A,
      idkitResult({ wallet: CREATOR_A, nullifier: N2 }),
    );

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('WALLET_TAKEN');
    expect(h.registry.sends).toBe(1);
  });

  it('every spelling of a nullifier is the same human', async () => {
    const h = await registered();
    const shouting = `0x${N1.slice(2).toUpperCase()}`;
    const res = await postVerify(
      h.app,
      CREATOR_B,
      idkitResult({ wallet: CREATOR_B, nullifier: shouting }),
    );
    expect(res.json().code).toBe('ALREADY_REGISTERED');

    const short = '0x00000000abc';
    const h2 = await harness();
    await postVerify(h2.app, CREATOR_A, idkitResult({ wallet: CREATOR_A, nullifier: short }));
    const res2 = await postVerify(
      h2.app,
      CREATOR_B,
      idkitResult({ wallet: CREATOR_B, nullifier: '0xABC' }),
    );
    expect(res2.json().code).toBe('ALREADY_REGISTERED');
  });

});

describe('POST /api/verify: rejected proofs', () => {
  it('T2.3: a proof made for B with the wallet swapped to U is INVALID_PROOF', async () => {
    const h = await harness();
    const res = await postVerify(h.app, WALLET_U, idkitResult({ wallet: CREATOR_B }));

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PROOF');
    expect(res.json().message).toMatch(/different wallet/);
    expect(h.worldCalls).toHaveLength(0);
    expect(h.registry.sends).toBe(0);
  });

  it('T2.6: a device-level proof is rejected with a clear message', async () => {
    const h = await harness({ world: { ...WORLD, protocolVersion: '3.0' } });
    const res = await postVerify(
      h.app,
      CREATOR_A,
      idkitResult({ protocolVersion: '3.0', identifier: 'device' }),
    );

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PROOF');
    expect(res.json().message).toMatch(/Orb verification is required/);
    expect(h.worldCalls).toHaveLength(0);
  });

  it.each([
    ['selfie credential', { identifier: 'selfie', issuerSchemaId: 11 }],
    ['passport credential', { identifier: 'passport', issuerSchemaId: 9303 }],
    ['proof_of_human label on another schema', { issuerSchemaId: 11 }],
  ])('rejects a %s in 4.0', async (_name, options) => {
    const h = await harness();
    const res = await postVerify(h.app, CREATOR_A, idkitResult(options));
    expect(res.json().code).toBe('INVALID_PROOF');
    expect(h.worldCalls).toHaveLength(0);
  });

  it('rejects the other protocol version, which would be a second nullifier for one human', async () => {
    const h = await harness();
    const res = await postVerify(h.app, CREATOR_A, idkitResult({ protocolVersion: '3.0' }));
    expect(res.json().code).toBe('INVALID_PROOF');
    expect(res.json().message).toMatch(/protocol 4\.0/);
  });

  it('rejects a proof for another action, which would be a second nullifier for one human', async () => {
    const h = await harness();
    const res = await postVerify(h.app, CREATOR_A, idkitResult({ action: 'other-action' }));
    expect(res.json().code).toBe('INVALID_PROOF');
  });

  it('rejects a proof from another environment', async () => {
    const h = await harness();
    const res = await postVerify(h.app, CREATOR_A, idkitResult({ environment: 'production' }));
    expect(res.json().code).toBe('INVALID_PROOF');
  });

  it('rejects a second response riding along with a valid one', async () => {
    const h = await harness();
    const proof = idkitResult();
    const res = await postVerify(h.app, CREATOR_A, {
      ...proof,
      responses: [proof.responses[0], { ...proof.responses[0], identifier: 'device' }],
    });
    expect(res.json().code).toBe('INVALID_PROOF');
    expect(h.worldCalls).toHaveLength(0);
  });

  it('rejects a session proof', async () => {
    const h = await harness();
    const proof = idkitResult();
    const { nullifier: _omitted, ...item } = proof.responses[0]!;
    const res = await postVerify(h.app, CREATOR_A, {
      ...proof,
      responses: [{ ...item, session_nullifier: ['0xaaa', '0xbbb'] }],
    });
    expect(res.json().code).toBe('INVALID_PROOF');
  });

  it.each([
    ['zero', '0x0'],
    ['the field modulus itself', '0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001'],
    ['not hex', 'nil_abc'],
  ])('rejects a nullifier that is %s', async (_name, nullifier) => {
    const h = await harness();
    const res = await postVerify(h.app, CREATOR_A, idkitResult({ nullifier }));
    expect(res.json().code).toBe('INVALID_PROOF');
  });

  it('rejects a missing or empty signal hash', async () => {
    const h = await harness();
    const res = await postVerify(h.app, CREATOR_A, idkitResult({ signalHash: '0x0' }));
    expect(res.json().code).toBe('INVALID_PROOF');
  });

  it.each([
    'all_verifications_failed',
    'invalid_proof',
    'root_too_old',
    'invalid_merkle_root',
    'environment_mismatch',
  ])(
    'maps World code %s to INVALID_PROOF and sends nothing',
    async (code) => {
      const h = await harness();
      h.setWorld(() =>
        jsonResponse(400, {
          success: false,
          code,
          detail: 'failed',
          results: [{ identifier: 'proof_of_human', success: false, code: 'verification_error' }],
        }),
      );
      const res = await postVerify(h.app, CREATOR_A, idkitResult());

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_PROOF');
      expect(h.registry.sends).toBe(0);
    },
  );

  it.each([
    'invalid_proof',
    'invalid_root',
    'invalid_merkle_root',
    'root_too_old',
    'outdated_nullifier',
    'nullifier_from_future',
    'invalid_credential_issuer',
    'invalid_public_input',
    'invalid_format',
  ])('all_verifications_failed with the proof at fault (%s) is INVALID_PROOF', async (code) => {
    const h = await harness();
    h.setWorld(() =>
      jsonResponse(400, {
        success: false,
        code: 'all_verifications_failed',
        results: [{ identifier: 'proof_of_human', success: false, code }],
      }),
    );
    const res = await postVerify(h.app, CREATOR_A, idkitResult());

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PROOF');
  });
});

describe('POST /api/verify: staging issuer', () => {
  const staging = idkitResult({ issuerSchemaId: 128 });

  it.each(['staging', 'sandbox'] as const)('accepts issuer 128 in %s', async (environment) => {
    const h = await harness({ world: { ...WORLD, environment } });
    const res = await postVerify(h.app, CREATOR_A, { ...staging, environment });
    expect(res.statusCode).toBe(200);
  });

  it('rejects issuer 128 in production, before calling World', async () => {
    const h = await harness({ world: { ...WORLD, environment: 'production' } });
    const res = await postVerify(h.app, CREATOR_A, { ...staging, environment: 'production' });

    expect(res.json().code).toBe('INVALID_PROOF');
    expect(res.json().message).toMatch(/Orb verification is required/);
    expect(h.worldCalls).toHaveLength(0);
  });

  it('accepts issuer 128 only for proof_of_human', async () => {
    const h = await harness();
    const res = await postVerify(
      h.app,
      CREATOR_A,
      idkitResult({ identifier: 'selfie', issuerSchemaId: 128 }),
    );
    expect(res.json().code).toBe('INVALID_PROOF');
  });
});

describe('POST /api/verify: wallet ownership', () => {
  it('an attacker cannot register a victim wallet with a proof made for its address', async () => {
    const h = await harness();
    const proof = idkitResult({ wallet: CREATOR_A, nullifier: N2 });
    const res = await postVerify(h.app, CREATOR_A, proof, {
      walletSignature: await walletSignatureFor(WALLET_U),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PROOF');
    expect(res.json().message).toMatch(/wallet signature/);
    expect(h.worldCalls).toHaveLength(0);
    expect(h.registry.sends).toBe(0);

    // The victim's own verification is unaffected.
    const own = await postVerify(h.app, CREATOR_A, idkitResult({ wallet: CREATOR_A }));
    expect(own.statusCode).toBe(200);
  });

  it('rejects a signature that recovers to nothing', async () => {
    const h = await harness();
    const res = await postVerify(h.app, CREATOR_A, idkitResult(), {
      walletSignature: JUNK_SIGNATURE,
    });
    expect(res.json().code).toBe('INVALID_PROOF');
  });

  it('rejects a signature made for another request nonce', async () => {
    const h = await harness();
    const res = await postVerify(h.app, CREATOR_A, idkitResult(), {
      walletSignature: await walletSignatureFor(CREATOR_A, '0x1234'),
    });
    expect(res.json().code).toBe('INVALID_PROOF');
  });

  it('rejects a signature made for another action', async () => {
    const h = await harness();
    const res = await postVerify(h.app, CREATOR_A, idkitResult(), {
      walletSignature: await walletSignatureFor(CREATOR_A, NONCE, 'other-action'),
    });
    expect(res.json().code).toBe('INVALID_PROOF');
  });

  it('does not depend on how the IDKit result spells the nonce', async () => {
    const h = await harness();
    const res = await postVerify(
      h.app,
      CREATOR_A,
      { ...idkitResult(), nonce: NONCE.replace('0x00', '0x').toUpperCase().replace('0X', '0x') },
      { walletSignature: await walletSignatureFor(CREATOR_A) },
    );
    expect(res.statusCode).toBe(200);
  });

  it('rejects a nonce that is not a number', async () => {
    const h = await harness();
    const res = await postVerify(h.app, CREATOR_A, idkitResult({ nonce: 'not-hex' }), {
      walletSignature: JUNK_SIGNATURE,
    });
    expect(res.json().code).toBe('INVALID_PROOF');
    expect(res.json().message).toMatch(/nonce/);
  });

  it.each([
    ['missing', undefined],
    ['too short', '0x1234'],
    ['not hex', `0x${'zz'.repeat(65)}`],
  ])('a walletSignature that is %s is BAD_REQUEST', async (_name, walletSignature) => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/verify',
      payload: { wallet: CREATOR_A, walletSignature, idkitResponse: idkitResult() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });
});

describe('POST /api/verify: World unavailable', () => {
  const failures: [string, () => Response | never][] = [
    // Captured from the live endpoint with a nonexistent RP ID on 2026-11-06.
    [
      'wrong RP ID (app_not_migrated)',
      () =>
        jsonResponse(400, {
          code: 'app_not_migrated',
          detail: 'This app has not been migrated to World ID 4.0. Please use the v2 verify endpoint.',
          attribute: null,
          app_id: 'rp_0000000000000000',
        }),
    ],
    ['app not found (404)', () => jsonResponse(404, { success: false, code: 'not_found', detail: 'x' })],
    ['server error (500)', () => jsonResponse(500, { error: 'boom' })],
    ['rate limited (429)', () => jsonResponse(429, {})],
    ['non-JSON body', () => new Response('<html>bad gateway</html>', { status: 502 })],
    ['unknown 400 code', () => jsonResponse(400, { code: 'not_registered', detail: 'pending' })],
    ...['verification_failed', 'generic_error', 'prover_error', 'internal_error'].map(
      (code): [string, () => Response] => [
        `World's own failure behind all_verifications_failed (${code})`,
        () =>
          jsonResponse(400, {
            success: false,
            code: 'all_verifications_failed',
            detail: 'All proof verifications failed.',
            results: [{ identifier: 'proof_of_human', success: false, code }],
          }),
      ],
    ),
    [
      'all_verifications_failed without a per-proof reason',
      () => jsonResponse(400, { success: false, code: 'all_verifications_failed' }),
    ],
    ['200 without success', () => jsonResponse(200, { success: false })],
    [
      '200 for the wrong environment',
      () =>
        jsonResponse(200, {
          success: true,
          environment: 'production',
          results: [{ identifier: 'proof_of_human', success: true }],
        }),
    ],
    [
      '200 where our credential did not verify',
      () =>
        jsonResponse(200, {
          success: true,
          environment: 'staging',
          results: [{ identifier: 'proof_of_human', success: false }],
        }),
    ],
    [
      '200 for a different nullifier',
      () =>
        jsonResponse(200, {
          success: true,
          environment: 'staging',
          nullifier: N2,
          results: [{ identifier: 'proof_of_human', success: true }],
        }),
    ],
    [
      'network failure',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ];

  it.each(failures)('T2.7 logic: %s returns 502 and sends no transaction', async (_name, respond) => {
    const h = await harness();
    h.setWorld(respond);
    const res = await postVerify(h.app, CREATOR_A, idkitResult());

    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('WORLD_UNAVAILABLE');
    expect(h.registry.sends).toBe(0);
  });
});

describe('POST /api/verify: chain failures', () => {
  it('a failed contract read is CHAIN_ERROR, before any call to World', async () => {
    const h = await harness();
    h.registry.failReads = true;
    const res = await postVerify(h.app, CREATOR_A, idkitResult());

    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('CHAIN_ERROR');
    expect(h.worldCalls).toHaveLength(0);
  });

  it('a failed send is CHAIN_ERROR, and a retry for that wallet finishes during a World outage', async () => {
    const h = await harness();
    h.registry.failSends = 1;
    const proof = idkitResult();

    const first = await postVerify(h.app, CREATOR_A, proof);
    expect(first.statusCode).toBe(502);
    expect(first.json().code).toBe('CHAIN_ERROR');

    h.setWorld(() => jsonResponse(500, {}));
    const retry = await postVerify(h.app, CREATOR_A, proof);

    expect(retry.statusCode).toBe(200);
    expect(h.worldCalls).toHaveLength(1);
    expect(h.registry.byNullifier.get(N1)).toBe(getAddress(CREATOR_A));
  });

  // World answers 200 to a nullifier it has seen ("nullifier reuse"), which is what
  // the default stub in the harness does on the second call below.
  it('a failed send does not bind the human to that wallet: a new proof for another wallet registers', async () => {
    const h = await harness();
    h.registry.failSends = 1;
    await postVerify(h.app, CREATOR_A, idkitResult({ wallet: CREATOR_A }));

    const res = await postVerify(h.app, CREATOR_B, idkitResult({ wallet: CREATOR_B }));

    expect(res.statusCode).toBe(200);
    expect(h.worldCalls).toHaveLength(2);
    expect(h.registry.byNullifier.get(N1)).toBe(getAddress(CREATOR_B));
  });

  it('another human taking the first wallet does not lock the first human out', async () => {
    const h = await harness();
    h.registry.failSends = 1;
    await postVerify(h.app, CREATOR_A, idkitResult({ wallet: CREATOR_A, nullifier: N1 }));

    const other = await postVerify(
      h.app,
      CREATOR_A,
      idkitResult({ wallet: CREATOR_A, nullifier: N2 }),
    );
    expect(other.statusCode).toBe(200);

    const taken = await postVerify(
      h.app,
      CREATOR_A,
      idkitResult({ wallet: CREATOR_A, nullifier: N1 }),
    );
    expect(taken.json().code).toBe('WALLET_TAKEN');

    const moved = await postVerify(
      h.app,
      CREATOR_B,
      idkitResult({ wallet: CREATOR_B, nullifier: N1 }),
    );
    expect(moved.statusCode).toBe(200);
  });

  it('a stale row is no way around World: a bad proof for another wallet changes nothing', async () => {
    const h = await harness();
    h.registry.failSends = 1;
    await postVerify(h.app, CREATOR_A, idkitResult({ wallet: CREATOR_A }));

    h.setWorld(() => jsonResponse(400, { code: 'invalid_proof', detail: 'bad' }));
    const forged = await postVerify(h.app, CREATOR_B, idkitResult({ wallet: CREATOR_B }));
    expect(forged.json().code).toBe('INVALID_PROOF');
    expect(h.registry.byNullifier.size).toBe(0);

    const retry = await postVerify(h.app, CREATOR_A, idkitResult({ wallet: CREATOR_A }));
    expect(retry.statusCode).toBe(200);
    expect(h.registry.byNullifier.get(N1)).toBe(getAddress(CREATOR_A));
  });

  it('a revert from a lost race resolves to 409, not CHAIN_ERROR', async () => {
    const h = await harness();
    h.registry.beforeSend = async () => {
      h.registry.byNullifier.set(N1, getAddress(CREATOR_B));
      h.registry.creators.add(getAddress(CREATOR_B));
    };
    const res = await postVerify(h.app, CREATOR_A, idkitResult());

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ALREADY_REGISTERED');
    expect(res.json().message).toContain(getAddress(CREATOR_B));
  });

  it('a revert because the wallet was taken meanwhile resolves to WALLET_TAKEN', async () => {
    const h = await harness();
    h.registry.beforeSend = async () => {
      h.registry.creators.add(getAddress(CREATOR_A));
    };
    const res = await postVerify(h.app, CREATOR_A, idkitResult());
    expect(res.json().code).toBe('WALLET_TAKEN');
  });
});

describe('POST /api/verify: concurrency', () => {
  function gated(h: Awaited<ReturnType<typeof harness>>) {
    let open!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const sending = new Promise<void>((resolve) => (reached = resolve));
    h.registry.beforeSend = () => {
      reached();
      return gate;
    };
    return { open, sending };
  }

  it('two requests for one human send one transaction', async () => {
    const h = await harness();
    const { open, sending } = gated(h);
    const first = postVerify(h.app, CREATOR_A, idkitResult({ wallet: CREATOR_A }));
    await sending;
    const second = await postVerify(h.app, CREATOR_B, idkitResult({ wallet: CREATOR_B }));
    open();

    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('ALREADY_REGISTERED');
    expect((await first).statusCode).toBe(200);
    expect(h.registry.sends).toBe(1);
  });

  it('two humans racing for one wallet send one transaction', async () => {
    const h = await harness();
    const { open, sending } = gated(h);
    const first = postVerify(h.app, CREATOR_A, idkitResult({ nullifier: N1 }));
    await sending;
    const second = await postVerify(h.app, CREATOR_A, idkitResult({ nullifier: N2 }));
    open();

    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('WALLET_TAKEN');
    expect((await first).statusCode).toBe(200);
    expect(h.registry.sends).toBe(1);
  });

  it('truly simultaneous duplicates still produce exactly one success', async () => {
    const h = await harness();
    const proof = idkitResult();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => postVerify(h.app, CREATOR_A, proof)),
    );

    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
    expect(h.registry.sends).toBe(1);
  });

  it('releases its claim after a failure, so a retry is not stuck', async () => {
    const h = await harness();
    h.setWorld(() => jsonResponse(500, {}));
    await postVerify(h.app, CREATOR_A, idkitResult());
    h.setWorld((body) =>
      jsonResponse(200, {
        success: true,
        environment: 'staging',
        results: [{ identifier: body.responses[0]!.identifier, success: true }],
      }),
    );
    const res = await postVerify(h.app, CREATOR_A, idkitResult());
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/verify: input and limits', () => {
  it.each([
    ['not an address', 'nope'],
    ['too short', '0x1234'],
    ['the zero address', '0x0000000000000000000000000000000000000000'],
    ['missing', undefined],
    ['a number', 7],
  ])('wallet %s is BAD_REQUEST', async (_name, wallet) => {
    const h = await harness();
    const res = await postVerify(h.app, wallet, idkitResult());
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('a malformed IDKit result is BAD_REQUEST', async () => {
    const h = await harness();
    const res = await postVerify(h.app, CREATOR_A, { responses: [] });
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('malformed JSON keeps the error shape', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/verify',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ code: 'BAD_REQUEST', message: expect.any(String) });
  });

  it('an unknown route keeps the error shape', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('limits by wallet across different IPs and spellings', async () => {
    const h = await harness({ rateLimits: { verifyByWallet: { max: 2, timeWindow: 60_000 } } });
    const proof = idkitResult({ wallet: CREATOR_A });
    const send = (wallet: string, remoteAddress: string) =>
      postVerify(h.app, wallet, proof, { remoteAddress });

    expect((await send(CREATOR_A, '10.0.0.1')).statusCode).toBe(200);
    expect((await send(CREATOR_A.toLowerCase(), '10.0.0.2')).statusCode).toBe(409);
    const blocked = await send(CREATOR_A, '10.0.0.3');

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ code: 'RATE_LIMITED', message: expect.any(String) });
  });

  it('nobody can use up a wallet limit without the wallet: the owner still gets through', async () => {
    const h = await harness({ rateLimits: { verifyByWallet: { max: 1, timeWindow: 60_000 } } });
    const noProof = () =>
      h.app.inject({
        method: 'POST',
        url: '/api/verify',
        remoteAddress: '10.0.0.66',
        payload: { wallet: CREATOR_A },
      });
    const wrongSigner = async () =>
      postVerify(h.app, CREATOR_A, idkitResult({ wallet: CREATOR_A }), {
        remoteAddress: '10.0.0.66',
        walletSignature: await walletSignatureFor(WALLET_U),
      });

    for (let i = 0; i < 5; i++) {
      expect((await noProof()).statusCode).toBe(400);
      expect((await wrongSigner()).statusCode).toBe(400);
    }

    const owner = await postVerify(h.app, CREATOR_A, idkitResult({ wallet: CREATOR_A }), {
      remoteAddress: '10.0.0.7',
    });
    expect(owner.statusCode).toBe(200);
  });

  it('limits by IP across different wallets', async () => {
    const h = await harness({ rateLimits: { verifyByIp: { max: 2, timeWindow: 60_000 } } });
    const send = (wallet: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/verify',
        remoteAddress: '10.0.0.9',
        payload: { wallet, idkitResponse: {} },
      });
    await send(CREATOR_A);
    await send(CREATOR_B);
    const blocked = await send(WALLET_U);

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe('RATE_LIMITED');
  });

  it('a limit on one route leaves other routes alone', async () => {
    const h = await harness({ rateLimits: { verifyByIp: { max: 1, timeWindow: 60_000 } } });
    const verify = () =>
      h.app.inject({ method: 'POST', url: '/api/verify', payload: { wallet: CREATOR_A } });
    await verify();
    expect((await verify()).statusCode).toBe(429);
    expect((await h.app.inject({ method: 'POST', url: '/api/rp-signature' })).statusCode).toBe(200);
  });

  it('tells the client when to retry', async () => {
    const h = await harness({ rateLimits: { verifyByWallet: { max: 1, timeWindow: 60_000 } } });
    const send = () => postVerify(h.app, CREATOR_A, idkitResult({ wallet: CREATOR_A }));
    await send();
    const res = await send();
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('a limit on one wallet leaves other wallets alone', async () => {
    const h = await harness({ rateLimits: { verifyByWallet: { max: 1, timeWindow: 60_000 } } });
    const send = (wallet: Address, nullifier: string) =>
      postVerify(h.app, wallet, idkitResult({ wallet, nullifier }));
    await send(CREATOR_A, N1);
    expect((await send(CREATOR_A, N1)).statusCode).toBe(429);
    expect((await send(CREATOR_B, N2)).statusCode).toBe(200);
  });
});

describe('logging', () => {
  it('keeps the reason a chain call failed but removes any address from it', () => {
    const err = Object.assign(new Error('full message with request body'), {
      shortMessage: `Error: WalletAlreadyRegistered(address wallet) (${CREATOR_A})`,
    });
    expect(logReason(err)).toBe('Error: WalletAlreadyRegistered(address wallet) (<address>)');
    expect(logReason(new TypeError('x'))).toBe('TypeError');
    expect(logReason(Object.assign(new Error('x'), { name: 'StatusError', status: 'PAYER_ACCOUNT_NOT_FOUND' }))).toBe(
      'StatusError: PAYER_ACCOUNT_NOT_FOUND',
    );
  });

  it('logs the transaction ID and nullifier hash, and never the wallet or client IP', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const h = await harness({ logger: { level: 'trace', stream } });
    h.registry.failSends = 1;

    const proof = idkitResult();
    await postVerify(h.app, CREATOR_A, proof);
    await postVerify(h.app, CREATOR_A, proof);

    const log = lines.join('');
    expect(log).toContain(N1);
    expect(log).toContain('0.0.1234-1793960511-');
    expect(log.toLowerCase()).not.toContain(CREATOR_A.toLowerCase());
    expect(log).not.toContain('127.0.0.1');
    expect(log).not.toContain('proof_of_human');
  });
});
