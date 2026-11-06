import type { Address } from '@reputed/shared';
import { keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { SCORING_CONFIG as CONFIG } from './config.ts';
import { classifyReviews, normalizeValue, verifyPayment } from './filter.ts';
import { confirmMisconduct, countsAgainstCreator, decayedPoints, nextHalvingAt } from './misconduct.ts';
import { computeScores, creatorScore, tierFor } from './score.ts';
import { buildSnapshot, canonicalJson, chunksNeeded, computeInputsHash, epochOf, hasOnlyFiniteScores } from './snapshot.ts';
import { addDays, fromMillis } from './time.ts';
import { hashscanTxId, parsePaymentProof, toMirrorTransactionId, toSdkTransactionId } from './txid.ts';
import type { AgentInput, ReviewInput, ScoringInputs } from './types.ts';
import { buildWalletBindings, walletDirectory } from './wallets.ts';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const CREATOR_A = addr(0xa);
const CREATOR_B = addr(0xb);
const CREATOR_C = addr(0xc);
const CREATOR_D = addr(0xd);
const CREATOR_E = addr(0xe);
const WALLET_A1 = addr(0xa1);
const WALLET_A2 = addr(0xa2);
const WALLET_A3 = addr(0xa3);
const WALLET_B1 = addr(0xb1);
const WALLET_C1 = addr(0xc1);
const WALLET_D1 = addr(0xd1);
const WALLET_U = addr(0xee);

const T0 = '1800000000.000000000';
const at = (days: number) => addDays(T0, days);
const TOPIC = '0.0.500';

function agent(id: string, creator: Address | null, wallet: Address, extra: Partial<AgentInput> = {}): AgentInput {
  return {
    agentId: id,
    creator,
    vouchedWallets: creator ? [{ wallet, from: T0 }] : [],
    compromisedAt: null,
    walletHistory: [{ wallet, from: T0 }],
    ownerHistory: [{ owner: creator ?? WALLET_U, from: T0 }],
    ...extra,
  };
}

const account = (wallet: Address) => `0.0.${BigInt(wallet)}`;
const allWallets = [
  CREATOR_A, CREATOR_B, CREATOR_C, CREATOR_D, CREATOR_E,
  WALLET_A1, WALLET_A2, WALLET_A3, WALLET_B1, WALLET_C1, WALLET_D1, WALLET_U,
];

function world(reviews: ReviewInput[], agents?: AgentInput[]): ScoringInputs {
  return {
    reviewsTopicId: TOPIC,
    creators: [CREATOR_A, CREATOR_B, CREATOR_C, CREATOR_D, CREATOR_E].map((wallet) => ({ wallet, registeredAt: T0 })),
    agents: agents ?? [
      agent('1', CREATOR_A, WALLET_A1),
      agent('2', CREATOR_A, WALLET_A2),
      agent('3', CREATOR_B, WALLET_B1),
      agent('4', CREATOR_C, WALLET_C1),
      agent('5', CREATOR_D, WALLET_D1),
    ],
    reviews,
    accounts: Object.fromEntries(allWallets.map((wallet) => [wallet, account(wallet)])),
  };
}

let serial = 0;
interface ReviewOptions {
  agentId?: string;
  to?: Address;
  value?: number;
  decimals?: number;
  tag1?: string;
  tag2?: string;
  day?: number;
  paid?: boolean;
  txId?: string;
  revokedAt?: string;
}

function review(client: Address, options: ReviewOptions = {}): ReviewInput {
  serial += 1;
  const { agentId = '1', to = WALLET_A1, value = 90, decimals = 0, tag1 = 'quality', tag2 = 'accuracy', day = 1, paid = true } = options;
  const txId = options.txId ?? `0.0.${BigInt(client)}-1800000000-${String(serial).padStart(9, '0')}`;
  const file = JSON.stringify({
    agentRegistry: 'eip155:296:0x8004A818BFB912233c491871b3d84c89A494BD9e',
    agentId: Number(agentId),
    clientAddress: `eip155:296:${client}`,
    value,
    valueDecimals: decimals,
    tag1,
    tag2,
    comment: 'ok',
    proofOfPayment: txId,
  });
  const bytes = Buffer.from(file, 'utf8');
  return {
    agentId,
    client,
    feedbackIndex: serial,
    value: String(value),
    valueDecimals: decimals,
    tag1,
    tag2,
    endpoint: 'https://agent.example',
    feedbackUri: `hcs://${TOPIC}/${serial}`,
    feedbackHash: keccak256(bytes),
    timestamp: at(day),
    logIndex: serial,
    txHash: `0x${serial.toString(16).padStart(64, '0')}`,
    revokedAt: options.revokedAt ?? null,
    fileBase64: bytes.toString('base64'),
    payment: paid
      ? {
          txId,
          result: 'SUCCESS',
          consensusTimestamp: addDays(at(day), -0.01),
          transfers: [
            { account: account(client), amount: '-100001000', tokenId: null },
            { account: account(to), amount: '100000000', tokenId: null },
            { account: '0.0.802', amount: '1000', tokenId: null },
          ],
        }
      : null,
  };
}

const score = (inputs: ScoringInputs, now = at(2)) => computeScores(inputs, CONFIG, now);
const agentOf = (result: ReturnType<typeof score>, id: string) => result.agents.find((item) => item.agentId === id)!;
const creatorOf = (result: ReturnType<typeof score>, creator: Address) => result.creators.find((item) => item.creator === creator)!;

describe('config', () => {
  it('holds the plan values under a version', () => {
    expect(CONFIG).toMatchObject({
      configVersion: 2,
      reviewHalfLifeDays: 90,
      penaltyHalfLifeDays: 180,
      reviewerWeightFloor: 0.2,
      penalties: { fraud: 20, 'failed-settlement': 10 },
      misconduct: { distinctCreators: 2, windowDays: 30, reporterCooldownDays: 180 },
      tierCutoffs: { tier1: 90, tier2: 75 },
    });
  });
});

describe('value parsing', () => {
  it('normalises int128 with valueDecimals', () => {
    expect(normalizeValue('90', 0)).toBe(90);
    expect(normalizeValue('905', 1)).toBe(90.5);
    expect(normalizeValue(100_000000000000000000n, 18)).toBe(100);
  });
  it('rejects values outside 0-100 and bad decimals', () => {
    expect(normalizeValue('-1', 0)).toBeNull();
    expect(normalizeValue('101', 0)).toBeNull();
    expect(normalizeValue('1001', 1)).toBeNull();
    expect(normalizeValue('1', 19)).toBeNull();
    expect(normalizeValue('170141183460469231731687303715884105727', 0)).toBeNull();
  });
});

describe('transaction IDs', () => {
  it('converts between the SDK and Mirror Node forms', () => {
    expect(toMirrorTransactionId('0.0.123@1700000000.000000005')).toBe('0.0.123-1700000000-000000005');
    expect(toSdkTransactionId('0.0.123-1700000000-000000005')).toBe('0.0.123@1700000000.000000005');
  });
  it('gives one spelling per transaction', () => {
    expect(toMirrorTransactionId('0.0.123@1700000000.5')).toBe(toMirrorTransactionId('0.0.123-1700000000-000000005'));
  });
  it('rejects anything else', () => {
    for (const bad of ['', 'made-up', '0.0.123@1700000000', '0.0.123@1.2-3', '0.0.x-1-2']) {
      expect(toMirrorTransactionId(bad)).toBeNull();
    }
  });
  it('rejects IDs Mirror answers 400 to', () => {
    for (const bad of [
      '0.0.1-9999999999999999999-1',
      '0.0.1-9223372036854775808-1',
      '1024.0.3-1700000000-1',
      '0.65536.3-1700000000-1',
      '0.0.274877906944-1700000000-1',
      '0.0.0-1700000000-1',
    ]) {
      expect(toMirrorTransactionId(bad)).toBeNull();
      expect(parsePaymentProof(bad)).toBeNull();
    }
  });
  it('rejects valid starts Mirror answers 503 to, which would otherwise be retried forever', () => {
    for (const bad of ['0.0.1-9223369937-1', '0.0.1-9223372036-1', '0.0.1-9223372036854775807-1']) {
      expect(toMirrorTransactionId(bad)).toBeNull();
    }
  });
  it('keeps IDs at the limits Mirror still answers', () => {
    expect(toMirrorTransactionId('1023.65535.274877906943-9000000000-999999999')).toBe('1023.65535.274877906943-9000000000-999999999');
    expect(toMirrorTransactionId('0.1.0-1700000000-1')).toBe('0.1.0-1700000000-000000001');
  });
  it('accepts an EVM hash as proof, and nothing that is not a string', () => {
    const hash = `0x${'aB'.repeat(32)}`;
    expect(parsePaymentProof(hash)).toEqual({ kind: 'eth-hash', key: hash.toLowerCase() });
    expect(parsePaymentProof(undefined)).toBeNull();
    expect(parsePaymentProof({ txId: 'x' })).toBeNull();
  });
});

describe('hashscanTxId', () => {
  const at = '1800000000.000000001';
  it('keeps a 32-byte 0x hash', () => {
    const hash = `0x${'aB'.repeat(32)}`;
    expect(hashscanTxId(hash, at)).toBe(hash);
  });
  it('uses the consensus timestamp for anything else', () => {
    for (const other of ['0.0.5@1700000000.000000001', '0.0.5-1700000000-000000001', `0x${'ab'.repeat(48)}`, `${'ab'.repeat(32)}`, '']) {
      expect(hashscanTxId(other, at), other).toBe(at);
    }
  });
});

describe('review filter', () => {
  const reasonOf = (item: ReviewInput, agents?: AgentInput[]) => classifyReviews(world([item], agents))[0]!.exclusionReason;

  it('counts a clean review', () => {
    const [classified] = classifyReviews(world([review(WALLET_B1)]));
    expect(classified).toMatchObject({ counted: true, paymentVerified: true, reviewerCreator: CREATOR_B, normalizedValue: 90, comment: 'ok' });
    expect(classified!.exclusionReason).toBeUndefined();
  });
  it('excludes a revoked review', () => {
    expect(reasonOf(review(WALLET_B1, { revokedAt: at(1.5) }))).toBe('revoked');
  });
  it('excludes a file whose hash differs', () => {
    expect(reasonOf({ ...review(WALLET_B1), feedbackHash: `0x${'0'.repeat(64)}` })).toBe('hash-mismatch');
  });
  it('excludes a review with no readable file', () => {
    expect(reasonOf({ ...review(WALLET_B1), fileBase64: null })).toBe('hash-mismatch');
  });
  it('excludes a file with non-string tags instead of crashing the scorer', () => {
    const item = review(WALLET_B1);
    const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(item.fileBase64!, 'base64').toString()), tag1: 5, tag2: { a: 1 } }));
    const hostile = { ...item, fileBase64: bytes.toString('base64'), feedbackHash: keccak256(bytes) };
    expect(reasonOf(hostile)).toBe('hash-mismatch');
  });
  it('excludes a file written for another agent, reviewer or value', () => {
    expect(reasonOf({ ...review(WALLET_B1), agentId: '2' })).toBe('hash-mismatch');
    expect(reasonOf({ ...review(WALLET_B1), client: WALLET_C1 })).toBe('hash-mismatch');
    expect(reasonOf({ ...review(WALLET_B1), value: '100' })).toBe('hash-mismatch');
    expect(reasonOf({ ...review(WALLET_B1), tag1: 'misconduct' })).toBe('hash-mismatch');
  });
  it('rejects an out-of-range value even when the file agrees with it', () => {
    expect(reasonOf(review(WALLET_B1, { value: 150 }))).toBe('invalid-value');
  });
  it('excludes a reviewer nobody backs', () => {
    const [classified] = classifyReviews(world([review(WALLET_U, { paid: false })]));
    expect(classified).toMatchObject({ counted: false, exclusionReason: 'not-human-backed', reviewerHumanBacked: false });
  });
  it('excludes a review from before the reviewer was human-backed', () => {
    const late = agent('3', CREATOR_B, WALLET_B1, { vouchedWallets: [{ wallet: WALLET_B1, from: at(5) }] });
    expect(reasonOf(review(WALLET_B1), [agent('1', CREATOR_A, WALLET_A1), late])).toBe('not-human-backed');
  });
  it('excludes a missing payment', () => {
    expect(reasonOf(review(WALLET_B1, { paid: false }))).toBe('payment-not-found');
  });
  it('excludes reviews from the same creator, through any of their wallets', () => {
    expect(reasonOf(review(WALLET_A2))).toBe('same-creator');
    expect(reasonOf(review(CREATOR_A))).toBe('same-creator');
  });
  it('still sees the same creator after the wallet left them', () => {
    const rotated = agent('2', CREATOR_A, WALLET_A2, {
      walletHistory: [{ wallet: WALLET_A2, from: T0 }, { wallet: null, from: at(0.5) }],
    });
    const third = agent('6', CREATOR_B, WALLET_A2, { vouchedWallets: [{ wallet: WALLET_A2, from: at(0.6) }], walletHistory: [{ wallet: WALLET_A2, from: at(0.6) }] });
    expect(reasonOf(review(WALLET_A2), [agent('1', CREATOR_A, WALLET_A1), rotated, third])).toBe('same-creator');
  });
});

describe('payment check', () => {
  const target = agent('1', CREATOR_A, WALLET_A1);
  const accounts = world([]).accounts;
  const check = (item: ReviewInput, on: AgentInput = target) => verifyPayment(item, on, accounts);

  it('passes a plain HBAR transfer', () => {
    expect(check(review(WALLET_B1))).toBe(true);
  });
  it('passes a token transfer', () => {
    const item = review(WALLET_B1);
    item.payment!.transfers = [
      { account: account(WALLET_B1), amount: '-5', tokenId: '0.0.77' },
      { account: account(WALLET_A1), amount: '5', tokenId: '0.0.77' },
    ];
    expect(check(item)).toBe(true);
  });
  it('fails a failed transaction', () => {
    const item = review(WALLET_B1);
    item.payment!.result = 'INSUFFICIENT_PAYER_BALANCE';
    expect(check(item)).toBe(false);
  });
  it('fails when someone else paid', () => {
    expect(check(review(WALLET_B1, { to: WALLET_A2 }))).toBe(false);
  });
  it('fails when the reviewer only covered the fee on a third party transfer', () => {
    const item = review(WALLET_B1);
    item.payment!.transfers = [
      { account: account(WALLET_B1), amount: '-1000', tokenId: null },
      { account: account(WALLET_C1), amount: '-100000000', tokenId: null },
      { account: account(WALLET_A1), amount: '100000000', tokenId: null },
      { account: '0.0.802', amount: '1000', tokenId: null },
    ];
    expect(check(item)).toBe(false);
  });
  it('fails a zero amount', () => {
    const item = review(WALLET_B1);
    item.payment!.transfers = [{ account: account(WALLET_B1), amount: '-1000', tokenId: null }, { account: '0.0.802', amount: '1000', tokenId: null }];
    expect(check(item)).toBe(false);
  });
  it('fails a payment at or after the review', () => {
    const item = review(WALLET_B1);
    item.payment!.consensusTimestamp = item.timestamp;
    expect(check(item)).toBe(false);
  });
  it('checks the wallet the agent had when the payment was made', () => {
    const history = [{ wallet: WALLET_A3, from: T0 }, { wallet: WALLET_A1, from: at(5) }];
    expect(check(review(WALLET_B1, { to: WALLET_A1 }), { ...target, walletHistory: history })).toBe(false);
    expect(check(review(WALLET_B1, { to: WALLET_A3 }), { ...target, walletHistory: history })).toBe(true);
  });
  it('keeps a payment made before the NFT transfer cleared the wallet', () => {
    const cleared = [{ wallet: WALLET_A1, from: T0 }, { wallet: null, from: at(1.5) }];
    expect(check(review(WALLET_B1), { ...target, walletHistory: cleared })).toBe(true);
    expect(check(review(WALLET_B1, { day: 3 }), { ...target, walletHistory: cleared })).toBe(false);
  });

  it('lets one payment back only one review, the earliest', () => {
    const first = review(WALLET_B1, { txId: '0.0.1-1800000000-000000001', day: 1 });
    const second = review(WALLET_B1, { txId: '0.0.1-1800000000-000000001', day: 1.5 });
    const classified = classifyReviews(world([second, first]));
    expect(classified.map((item) => item.counted)).toEqual([true, false]);
    expect(classified[1]!.exclusionReason).toBe('payment-not-found');
  });
  it('does not let a stranger burn a payment by citing it first', () => {
    const txId = '0.0.1-1800000000-000000002';
    const thief = review(WALLET_C1, { txId, day: 1 });
    thief.payment = review(WALLET_B1, { txId, day: 1 }).payment;
    const honest = review(WALLET_B1, { txId, day: 1.5 });
    const classified = classifyReviews(world([thief, honest]));
    expect(classified[0]!.exclusionReason).toBe('payment-not-found');
    expect(classified[1]!.counted).toBe(true);
  });
  it('does not let an unlinked agent someone looked up take a linked agent\'s payment', () => {
    const txId = '0.0.1-1800000000-000000004';
    const onUnlinked = review(CREATOR_B, { txId, agentId: '8', day: 1 });
    const onLinked = review(CREATOR_B, { txId, agentId: '7', day: 2 });
    const linked = agent('7', CREATOR_A, WALLET_A1);
    const lookedUp = agent('8', null, WALLET_A1);

    const epoch = score(world([onLinked], [linked]), at(3));
    const live = score(world([onUnlinked, onLinked], [linked, lookedUp]), at(3));
    expect(agentOf(live, '7')).toEqual(agentOf(epoch, '7'));
    expect(agentOf(live, '7').counted).toBe(1);
    expect(live.reviews.find((item) => item.agentId === '8')!.exclusionReason).toBe('payment-not-found');
  });
  it('still scores an unlinked agent from a payment nothing else claimed', () => {
    const lookedUp = agent('8', null, WALLET_A1);
    const result = score(world([review(CREATOR_B, { agentId: '8', value: 70 })], [lookedUp]));
    expect(agentOf(result, '8')).toMatchObject({ score: 70, counted: 1 });
  });
  it('frees the payment of a revoked review', () => {
    const txId = '0.0.1-1800000000-000000003';
    const classified = classifyReviews(world([
      review(WALLET_B1, { txId, day: 1, revokedAt: at(1.2) }),
      review(WALLET_B1, { txId, day: 1.5 }),
    ]));
    expect(classified[1]!.counted).toBe(true);
  });
});

describe('wallet to creator mapping', () => {
  const directoryFor = (agents: AgentInput[]) => walletDirectory(buildWalletBindings(world([]).creators, agents));

  it('maps creator wallets and link-time agent wallets', () => {
    const directory = directoryFor([agent('1', CREATOR_A, WALLET_A1)]);
    expect(directory.creatorAt(CREATOR_A, at(1))).toBe(CREATOR_A);
    expect(directory.creatorAt(WALLET_A1, at(1))).toBe(CREATOR_A);
    expect(directory.creatorAt(WALLET_U, at(1))).toBeNull();
  });
  it('fails closed like CreatorRegistry: rotation, NFT transfer, compromise', () => {
    const rotated = directoryFor([agent('1', CREATOR_A, WALLET_A1, {
      walletHistory: [{ wallet: WALLET_A1, from: T0 }, { wallet: WALLET_A2, from: at(1) }],
    })]);
    expect(rotated.creatorAt(WALLET_A1, at(0.5))).toBe(CREATOR_A);
    expect(rotated.creatorAt(WALLET_A1, at(2))).toBeNull();
    expect(rotated.creatorAt(WALLET_A2, at(2))).toBeNull();

    const sold = directoryFor([agent('1', CREATOR_A, WALLET_A1, {
      walletHistory: [{ wallet: WALLET_A1, from: T0 }, { wallet: null, from: at(1) }, { wallet: WALLET_A1, from: at(2) }],
      ownerHistory: [{ owner: CREATOR_A, from: T0 }, { owner: CREATOR_B, from: at(1) }],
    })]);
    expect(sold.creatorAt(WALLET_A1, at(3))).toBeNull();

    const compromised = directoryFor([agent('1', CREATOR_A, WALLET_A1, { compromisedAt: at(1) })]);
    expect(compromised.creatorAt(WALLET_A1, at(0.5))).toBe(CREATOR_A);
    expect(compromised.creatorAt(WALLET_A1, at(1.5))).toBeNull();
  });
  it('backs a rotated wallet only from syncAgentWallet, and backs it again after moving back', () => {
    const directory = directoryFor([agent('1', CREATOR_A, WALLET_A1, {
      vouchedWallets: [{ wallet: WALLET_A1, from: T0 }, { wallet: WALLET_A2, from: at(2) }],
      walletHistory: [
        { wallet: WALLET_A1, from: T0 },
        { wallet: WALLET_A2, from: at(1) },
        { wallet: WALLET_A1, from: at(3) },
        { wallet: WALLET_A2, from: at(4) },
      ],
    })]);
    expect(directory.creatorAt(WALLET_A2, at(1.5))).toBeNull();
    expect(directory.creatorAt(WALLET_A2, at(2.5))).toBe(CREATOR_A);
    expect(directory.creatorAt(WALLET_A1, at(2.5))).toBeNull();
    expect(directory.creatorAt(WALLET_A1, at(3.5))).toBe(CREATOR_A);
    expect(directory.creatorAt(WALLET_A2, at(3.5))).toBeNull();
    expect(directory.creatorAt(WALLET_A2, at(4.5))).toBe(CREATOR_A);
  });
  it('backs a grant-linked agent while its own account holds the NFT, and not after a sale', () => {
    const linked = (ownerHistory: AgentInput['ownerHistory'], walletHistory: AgentInput['walletHistory'] = [{ wallet: WALLET_A1, from: T0 }]) =>
      directoryFor([agent('1', CREATOR_A, WALLET_A1, { linkedOwner: WALLET_A1, ownerHistory, walletHistory })]);

    const kept = linked([{ owner: WALLET_A1, from: T0 }]);
    expect(kept.creatorAt(WALLET_A1, at(1))).toBe(CREATOR_A);

    // A transfer clears the agent wallet on the Identity Registry, which is what ends the binding.
    const sold = linked(
      [{ owner: WALLET_A1, from: T0 }, { owner: CREATOR_B, from: at(1) }],
      [{ wallet: WALLET_A1, from: T0 }, { wallet: null, from: at(1) }],
    );
    expect(sold.creatorAt(WALLET_A1, at(0.5))).toBe(CREATOR_A);
    expect(sold.creatorAt(WALLET_A1, at(2))).toBeNull();

    // An NFT held by the creator is not what a grant link vouched for.
    const wrongHolder = linked([{ owner: CREATOR_A, from: T0 }]);
    expect(wrongHolder.creatorAt(WALLET_A1, at(1))).toBeNull();
  });
  it('voids a shared wallet for every agent on it, as of the report', () => {
    const reported = agent('1', CREATOR_A, WALLET_U, { compromisedAt: at(2) });
    const sibling = agent('2', CREATOR_B, WALLET_U);
    const directory = directoryFor([sibling, reported]);
    expect(directory.creatorAt(WALLET_U, at(1))).toBe(CREATOR_A);
    expect(directory.creatorAt(WALLET_U, at(3))).toBeNull();
  });
  it('voids a wallet the reported agent already moved off', () => {
    const reported = agent('1', CREATOR_A, WALLET_U, {
      compromisedAt: at(2),
      walletHistory: [{ wallet: WALLET_U, from: T0 }, { wallet: WALLET_A1, from: at(1) }],
    });
    const directory = directoryFor([reported, agent('2', CREATOR_B, WALLET_U)]);
    expect(directory.creatorAt(WALLET_U, at(1.5))).toBe(CREATOR_B);
    expect(directory.creatorAt(WALLET_U, at(3))).toBeNull();
  });
  it('keeps a report from voiding a wallet that is never on the reported agent', () => {
    const directory = directoryFor([
      agent('1', CREATOR_A, WALLET_A1, { compromisedAt: at(2) }),
      agent('2', CREATOR_A, WALLET_A2),
    ]);
    expect(directory.creatorAt(WALLET_A2, at(3))).toBe(CREATOR_A);
  });
  it('leaves a creator wallet backed after a report on an agent using it', () => {
    const directory = directoryFor([agent('1', CREATOR_A, CREATOR_A, { compromisedAt: at(1) })]);
    expect(directory.creatorAt(CREATOR_A, at(2))).toBe(CREATOR_A);
  });
  it('resolves a wallet claimed by two creators the same way every time', () => {
    const one = agent('1', CREATOR_A, WALLET_U);
    const two = agent('2', CREATOR_B, WALLET_U, { vouchedWallets: [{ wallet: WALLET_U, from: at(1) }] });
    expect(directoryFor([one, two]).creatorAt(WALLET_U, at(2))).toBe(CREATOR_A);
    expect(directoryFor([two, one]).creatorAt(WALLET_U, at(2))).toBe(CREATOR_A);
  });
});

describe('agent score', () => {
  it('weights by the reviewer creator score, floored at 0.2', () => {
    // Creator C sits at 10 after its own agent scored 10, so its weight is the 0.2 floor.
    const reviews = [
      review(WALLET_D1, { agentId: '4', to: WALLET_C1, value: 10, day: 1 }),
      review(WALLET_B1, { value: 100, day: 1 }),
      review(WALLET_C1, { value: 0, day: 1 }),
    ];
    const result = score(world(reviews), at(1));
    expect(creatorOf(result, CREATOR_C).score).toBe(10);
    expect(agentOf(result, '1').score).toBeCloseTo((1 * 100 + 0.2 * 0) / 1.2, 1);
  });
  it('halves a review weight every 90 days', () => {
    const reviews = [review(WALLET_B1, { value: 100, day: 1 }), review(WALLET_C1, { value: 0, day: 91 })];
    expect(agentOf(score(world(reviews), at(91)), '1').score).toBeCloseTo((0.5 * 100) / 1.5, 1);
  });
  it('gives one creator one vote however many reviews it sends', () => {
    const spam = Array.from({ length: 50 }, (_, i) => review(WALLET_B1, { value: 100, day: 1 + i / 1000 }));
    const result = score(world([...spam, review(WALLET_C1, { value: 0, day: 1 })]), at(1.1));
    expect(agentOf(result, '1').score).toBeCloseTo(50, 0);
    expect(agentOf(result, '1')).toMatchObject({ counted: 51, distinctReviewers: 2 });
  });
  it('treats two wallets of one creator as one vote', () => {
    const extra = agent('7', CREATOR_B, WALLET_D1);
    const agents = [agent('1', CREATOR_A, WALLET_A1), agent('3', CREATOR_B, WALLET_B1), extra, agent('4', CREATOR_C, WALLET_C1)];
    const reviews = [review(WALLET_B1, { value: 100 }), review(WALLET_D1, { value: 100 }), review(WALLET_C1, { value: 0 })];
    expect(agentOf(score(world(reviews, agents), at(1)), '1').score).toBeCloseTo(50, 0);
  });
});

describe('tiers', () => {
  it('uses the cut-offs inclusively', () => {
    expect([90, 89.99, 75, 74.99].map((value) => tierFor(value, CONFIG))).toEqual(['Tier 1', 'Tier 2', 'Tier 2', 'Tier 3']);
  });
});

describe('misconduct confirmation', () => {
  const fraud = (client: Address, day: number) => review(client, { value: 0, tag1: 'misconduct', tag2: 'fraud', day });
  const penalties = (reviews: ReviewInput[], agents?: AgentInput[]) => {
    const inputs = world(reviews, agents);
    return confirmMisconduct(classifyReviews(inputs), inputs.agents, CONFIG, at(100));
  };

  it('needs two distinct creators', () => {
    expect(penalties([fraud(WALLET_B1, 1)])).toHaveLength(0);
    expect(penalties([fraud(WALLET_B1, 1), fraud(WALLET_C1, 2)])).toHaveLength(1);
  });
  it('does not let one creator confirm alone, from any number of reviews or wallets', () => {
    expect(penalties([fraud(WALLET_B1, 1), fraud(WALLET_B1, 2), fraud(CREATOR_B, 3)])).toHaveLength(0);
  });
  it('needs both reports inside 30 days', () => {
    expect(penalties([fraud(WALLET_B1, 1), fraud(WALLET_C1, 31)])).toHaveLength(1);
    expect(penalties([fraud(WALLET_B1, 1), fraud(WALLET_C1, 31.01)])).toHaveLength(0);
  });
  it('ignores reports that do not count', () => {
    expect(penalties([fraud(WALLET_B1, 1), { ...fraud(WALLET_C1, 2), payment: null }])).toHaveLength(0);
    expect(penalties([fraud(WALLET_B1, 1), fraud(WALLET_A2, 2)])).toHaveLength(0);
  });
  it('does not mix categories, and skips categories with no penalty', () => {
    const failed = review(WALLET_C1, { value: 0, tag1: 'misconduct', tag2: 'failed-settlement', day: 2 });
    expect(penalties([fraud(WALLET_B1, 1), failed])).toHaveLength(0);
    const other = (client: Address) => review(client, { value: 0, tag1: 'misconduct', tag2: 'spam', day: 2 });
    expect(penalties([other(WALLET_B1), other(WALLET_C1)])).toHaveLength(0);
  });
  it('turns one incident into one penalty, however many creators report it', () => {
    expect(penalties([fraud(WALLET_B1, 1), fraud(WALLET_C1, 2), fraud(WALLET_D1, 3)])).toHaveLength(1);
    expect(penalties([fraud(WALLET_B1, 1), fraud(WALLET_C1, 2), fraud(WALLET_D1, 3), fraud(CREATOR_E, 4)])).toHaveLength(1);
    expect(penalties([fraud(WALLET_B1, 1), fraud(WALLET_C1, 2), fraud(WALLET_D1, 3), fraud(WALLET_B1, 4)])).toHaveLength(1);
  });
  it('confirms a new incident after the window, from reporters who are not cooling down', () => {
    expect(penalties([fraud(WALLET_B1, 1), fraud(WALLET_C1, 2), fraud(WALLET_D1, 40), fraud(CREATOR_E, 41)])).toHaveLength(2);
    expect(penalties([fraud(WALLET_B1, 1), fraud(WALLET_C1, 2), fraud(WALLET_D1, 31), fraud(CREATOR_E, 33)])).toHaveLength(1);
  });
  it('does not let the same two reporters repeat a penalty', () => {
    const repeats = Array.from({ length: 5 }, (_, i) => [fraud(WALLET_C1, 1 + i / 100), fraud(WALLET_D1, 1 + i / 100)]).flat();
    expect(penalties(repeats)).toHaveLength(1);
    const result = score(world(repeats), at(2));
    expect(creatorOf(result, CREATOR_A).P).toBeLessThanOrEqual(20);
  });
  it('holds a reporter out for the whole cooldown, then lets it report again', () => {
    const pair = (day: number) => [fraud(WALLET_B1, day), fraud(WALLET_C1, day + 1)];
    expect(penalties([...pair(1), ...pair(100)])).toHaveLength(1);
    expect(penalties([...pair(1), ...pair(181)])).toHaveLength(1);
    expect(penalties([...pair(1), ...pair(190)])).toHaveLength(2);
  });
  it('lets one reporter stop a repeat only for itself', () => {
    expect(penalties([fraud(WALLET_B1, 1), fraud(WALLET_C1, 2), fraud(WALLET_B1, 40), fraud(WALLET_D1, 41), fraud(CREATOR_E, 42)])).toHaveLength(2);
  });
  it('keeps the cooldown to that agent and category', () => {
    const failed = (client: Address, day: number) => review(client, { value: 0, tag1: 'misconduct', tag2: 'failed-settlement', day });
    const onSecondAgent = (client: Address, day: number) => review(client, { agentId: '2', to: WALLET_A2, value: 0, tag1: 'misconduct', tag2: 'fraud', day });
    expect(penalties([fraud(WALLET_B1, 1), fraud(WALLET_C1, 2), failed(WALLET_B1, 3), failed(WALLET_C1, 4)])).toHaveLength(2);
    expect(penalties([fraud(WALLET_B1, 1), fraud(WALLET_C1, 2), onSecondAgent(WALLET_B1, 3), onSecondAgent(WALLET_C1, 4)])).toHaveLength(2);
  });
  it('ignores tags that only exist on the prototype of the penalty table', () => {
    for (const tag2 of ['constructor', '__proto__']) {
      const report = (client: Address) => review(client, { value: 0, tag1: 'misconduct', tag2 });
      expect(penalties([report(WALLET_C1), report(WALLET_D1)])).toHaveLength(0);
    }
  });
  it('keeps every score finite when reports use a prototype tag', () => {
    const report = (client: Address) => review(client, { value: 0, tag1: 'misconduct', tag2: 'constructor' });
    const bystander = review(CREATOR_A, { agentId: '5', to: WALLET_D1, value: 80 });
    const result = score(world([report(WALLET_C1), report(WALLET_D1), bystander]));
    expect(creatorOf(result, CREATOR_A)).toMatchObject({ score: 0, P: 0 });
    expect(agentOf(result, '5')).toMatchObject({ score: 80, counted: 1 });
    expect(result.iterations).toBeLessThan(CONFIG.fixedPointIterations);
    expect(hasOnlyFiniteScores(buildSnapshot(1, '0xabc', result))).toBe(true);
  });
  it('keeps a penalty when a report is revoked after confirmation', () => {
    const confirmed = [fraud(WALLET_B1, 1), fraud(WALLET_C1, 2)];
    const afterRevoke = [{ ...fraud(WALLET_B1, 1), revokedAt: at(4) }, fraud(WALLET_C1, 2)];
    const [before] = penalties(confirmed);
    const [after] = penalties(afterRevoke);
    expect({ ...after, reporters: [], reports: [] }).toEqual({ ...before, reporters: [], reports: [] });
    expect(after!.reporters).toEqual([CREATOR_B, CREATOR_C]);
    expect(after!.reports.map((report) => report.client)).toEqual([WALLET_B1, WALLET_C1]);
    expect(creatorOf(score(world(afterRevoke), at(5)), CREATOR_A).P).toBeGreaterThan(19);
  });
  it('records the reports open at confirmation, in order, and only those', () => {
    const reports = [fraud(WALLET_B1, 1), fraud(WALLET_B1, 40), fraud(WALLET_B1, 41), fraud(WALLET_C1, 42), fraud(WALLET_D1, 43)];
    const [penalty] = penalties(reports);
    expect(penalty!.reports).toEqual(
      [reports[1]!, reports[2]!, reports[3]!].map(({ client, feedbackIndex, txHash, timestamp }) => ({ client, feedbackIndex, txHash, timestamp })),
    );
  });
  it('leaves a report revoked before confirmation out of the reports', () => {
    const revoked = { ...fraud(WALLET_B1, 1), revokedAt: at(2) };
    const [penalty] = penalties([revoked, fraud(WALLET_C1, 3), fraud(WALLET_D1, 4)]);
    expect(penalty!.reports.map((report) => report.client)).toEqual([WALLET_C1, WALLET_D1]);
  });
  it('keeps a penalty when the confirming report is the one revoked', () => {
    expect(penalties([fraud(WALLET_B1, 1), { ...fraud(WALLET_C1, 2), revokedAt: at(3) }])).toHaveLength(1);
  });
  it('does not confirm from a report revoked before the second one landed', () => {
    expect(penalties([{ ...fraud(WALLET_B1, 1), revokedAt: at(1.5) }, fraud(WALLET_C1, 2)])).toHaveLength(0);
  });
  it('does not move a penalty across a compromise report when a report is revoked later', () => {
    const agents = world([]).agents.map((item) => (item.agentId === '1' ? { ...item, compromisedAt: at(1.5) } : item));
    const reports = [{ ...fraud(WALLET_B1, 1), revokedAt: at(4) }, fraud(WALLET_C1, 2), fraud(WALLET_D1, 3)];
    expect(penalties(reports, agents)[0]).toMatchObject({ firstReportAt: at(1), countsAgainstCreator: true });
  });
  it('does not count a revoked report that failed another rule', () => {
    expect(penalties([{ ...fraud(WALLET_B1, 1), payment: null, revokedAt: at(3) }, fraud(WALLET_C1, 2)])).toHaveLength(0);
  });
  it('still drops a revoked report from the average', () => {
    const result = score(world([{ ...review(WALLET_B1, { value: 10 }), revokedAt: at(1.5) }, review(WALLET_C1, { value: 90 })]));
    expect(agentOf(result, '1')).toMatchObject({ score: 90, counted: 1 });
  });
  it('uses the configured points per category', () => {
    const failed = (client: Address, day: number) => review(client, { value: 0, tag1: 'misconduct', tag2: 'failed-settlement', day });
    expect(penalties([failed(WALLET_B1, 1), failed(WALLET_C1, 2)])[0]).toMatchObject({ category: 'failed-settlement', basePoints: 10 });
  });
});

describe('penalty decay and compromise cut-off', () => {
  it('halves every 180 days', () => {
    expect(decayedPoints(20, T0, T0, CONFIG)).toBe(20);
    expect(decayedPoints(20, T0, at(180), CONFIG)).toBe(10);
    expect(decayedPoints(20, T0, at(360), CONFIG)).toBe(5);
  });
  it('dates a penalty by its first report', () => {
    expect(countsAgainstCreator(at(1), null)).toBe(true);
    expect(countsAgainstCreator(at(1), at(2))).toBe(true);
    expect(countsAgainstCreator(at(3), at(2))).toBe(false);
  });
});

describe('next halving', () => {
  const confirmed = '1800000000.123456789';
  const half = CONFIG.penaltyHalfLifeDays;

  it('is one half-life on, until that moment has passed', () => {
    expect(nextHalvingAt(confirmed, confirmed, CONFIG)).toBe(addDays(confirmed, half));
    expect(nextHalvingAt(confirmed, addDays(confirmed, half - 1), CONFIG)).toBe(addDays(confirmed, half));
  });
  it('moves on at the exact moment of a halving, to the nanosecond', () => {
    const halving = addDays(confirmed, half);
    expect(nextHalvingAt(confirmed, '1815552000.123456788', CONFIG)).toBe(halving);
    expect(nextHalvingAt(confirmed, halving, CONFIG)).toBe(addDays(confirmed, 2 * half));
  });
  it('skips whole half-lives that have passed', () => {
    expect(nextHalvingAt(confirmed, addDays(confirmed, 3 * half + 1), CONFIG)).toBe(addDays(confirmed, 4 * half));
  });
  it('is the first half-life when the clock is behind the chain', () => {
    expect(nextHalvingAt(confirmed, '1700000000.000000000', CONFIG)).toBe(addDays(confirmed, half));
  });
  it('uses the configured half-life', () => {
    expect(nextHalvingAt(confirmed, confirmed, { ...CONFIG, penaltyHalfLifeDays: 10 })).toBe(addDays(confirmed, 10));
  });
  it('agrees with the decay: the points halve at that moment', () => {
    const next = nextHalvingAt(confirmed, addDays(confirmed, 1), CONFIG);
    expect(decayedPoints(20, confirmed, next, CONFIG)).toBe(10);
  });
});

describe('fromMillis', () => {
  it('keeps milliseconds in the nanos, padded', () => {
    expect(fromMillis(1_800_000_000_007)).toBe('1800000000.007000000');
    expect(fromMillis(1_800_000_000_000)).toBe('1800000000.000000000');
  });
});

describe('creator score', () => {
  const none: never[] = [];
  it('averages agents by weight', () => {
    expect(creatorScore([{ score: 90, weight: 3 }, { score: 50, weight: 1 }], none)).toBe(80);
  });
  it('is 100 minus P with no reviewed agents', () => {
    expect(creatorScore([], none)).toBe(100);
  });
});

describe('new agent flag', () => {
  it('is only set when the score is inherited from a creator', () => {
    const result = score(world([], [agent('1', CREATOR_A, WALLET_A1), agent('8', null, WALLET_U)]));
    expect(agentOf(result, '1')).toMatchObject({ score: 100, isNew: true });
    expect(agentOf(result, '8')).toMatchObject({ score: 0, creator: null, isNew: false });
  });
});

describe('M9-M13 under the full formulas', () => {
  const good = () => review(WALLET_B1, { value: 90, day: 1 });
  const fraud = (client: Address) => review(client, { value: 0, tag1: 'misconduct', tag2: 'fraud', day: 1 });

  it('M8: a clean creator gives a new agent 100', () => {
    expect(agentOf(score(world([])), '1')).toMatchObject({ score: 100, isNew: true });
  });
  it('M9: 90, Tier 1, counted', () => {
    const result = score(world([good()]));
    expect(agentOf(result, '1')).toMatchObject({ score: 90, tier: 'Tier 1', counted: 1, isNew: false });
  });
  it('M10: the unverified 0 changes nothing', () => {
    const result = score(world([good(), review(WALLET_U, { value: 0, paid: false })]));
    expect(agentOf(result, '1')).toMatchObject({ score: 90, excluded: 1 });
  });
  it('M12: one report gives the same 45 and 45, but no penalty (the MVP doc adds 20)', () => {
    const result = score(world([good(), fraud(WALLET_C1)]));
    expect(agentOf(result, '1').score).toBe(45);
    expect(creatorOf(result, CREATOR_A)).toMatchObject({ score: 45, P: 0 });
    expect(creatorOf(result, CREATOR_B).score).toBe(100);
    expect(creatorOf(result, CREATOR_C).score).toBe(100);
  });
  it('M12: reviews an hour apart decay slightly, so 45 becomes 44.99', () => {
    const later = { ...fraud(WALLET_C1), timestamp: addDays(at(1), 1 / 24) };
    expect(agentOf(score(world([good(), later]), at(1.05)), '1').score).toBe(44.99);
  });
  it('M13: a new agent starts at the lowered 45', () => {
    const result = score(world([good(), fraud(WALLET_C1)]));
    expect(agentOf(result, '2')).toMatchObject({ score: 45, isNew: true, tier: 'Tier 3' });
  });
});

describe('T5.1-T5.9', () => {
  const quality = () => review(WALLET_B1, { value: 90, day: 1 });
  const fraud = (client: Address, options: ReviewOptions = {}) =>
    review(client, { value: 0, tag1: 'misconduct', tag2: 'fraud', day: 1, ...options });

  it('T5.1: A1 = 90, Tier 1', () => {
    expect(agentOf(score(world([quality()])), '1')).toMatchObject({ score: 90, tier: 'Tier 1' });
  });
  it('T5.2: U is excluded as not human-backed, A1 stays 90', () => {
    const result = score(world([quality(), review(WALLET_U, { value: 0, paid: false })]));
    expect(result.reviews.find((item) => item.client === WALLET_U)!.exclusionReason).toBe('not-human-backed');
    expect(agentOf(result, '1').score).toBe(90);
  });
  it('T5.3: a made-up payment is excluded', () => {
    const result = score(world([quality(), review(WALLET_B1, { value: 10, paid: false })]));
    expect(result.reviews.at(-1)!.exclusionReason).toBe('payment-not-found');
    expect(agentOf(result, '1').score).toBe(90);
  });
  it('T5.4: two creators report fraud: A1 drops, Creator A is at most 80, Creator B unchanged', () => {
    const before = score(world([quality()]));
    const result = score(world([quality(), fraud(WALLET_C1), fraud(WALLET_D1)]));
    expect(agentOf(result, '1').score).toBe(30);
    expect(agentOf(result, '1').score).toBeLessThan(agentOf(before, '1').score);
    const creator = creatorOf(result, CREATOR_A);
    expect(creator.P).toBeCloseTo(20, 0);
    expect(creator.score).toBeLessThanOrEqual(80);
    expect(creatorOf(result, CREATOR_B).score).toBe(creatorOf(before, CREATOR_B).score);
  });
  it('T5.4: when a reporter also left the 90, its vote is split and A1 lands at 22.5', () => {
    const result = score(world([quality(), fraud(WALLET_B1), fraud(WALLET_C1)]));
    expect(agentOf(result, '1').score).toBe(22.5);
  });
  it('a confirmed penalty caps the agent, so good reviews cannot hide it', () => {
    const reports = [
      review(WALLET_C1, { value: 100, tag1: 'misconduct', tag2: 'fraud' }),
      review(WALLET_D1, { value: 100, tag1: 'misconduct', tag2: 'fraud' }),
    ];
    const result = score(world([review(WALLET_B1, { value: 100 }), ...reports]), at(1));
    expect(agentOf(result, '1')).toMatchObject({ score: 80, penaltiesConfirmed: 1 });
  });
  it('T5.5: a new agent shows the creator score and New', () => {
    const result = score(world([quality(), fraud(WALLET_C1), fraud(WALLET_D1)]));
    expect(agentOf(result, '2')).toMatchObject({ score: creatorOf(result, CREATOR_A).score, isNew: true });
  });
  it('T5.6: after a compromise report the agent drops and P does not change', () => {
    const agents = world([]).agents.map((item) => (item.agentId === '2' ? { ...item, compromisedAt: at(1) } : item));
    const reports = [
      fraud(WALLET_C1, { agentId: '2', to: WALLET_A2, day: 2 }),
      fraud(WALLET_D1, { agentId: '2', to: WALLET_A2, day: 2 }),
    ];
    const result = score(world([quality(), ...reports], agents), at(3));
    expect(agentOf(result, '2')).toMatchObject({ score: 0, penaltiesConfirmed: 1 });
    expect(creatorOf(result, CREATOR_A).P).toBe(0);
  });
  it('T5.6: a report before the compromise still reaches the creator', () => {
    const agents = world([]).agents.map((item) => (item.agentId === '2' ? { ...item, compromisedAt: at(2.5) } : item));
    const reports = [
      fraud(WALLET_C1, { agentId: '2', to: WALLET_A2, day: 2 }),
      fraud(WALLET_D1, { agentId: '2', to: WALLET_A2, day: 3 }),
    ];
    expect(creatorOf(score(world(reports, agents), at(3)), CREATOR_A).P).toBeGreaterThan(19);
  });
  it('T5.7: many perfect reviews elsewhere cannot lift the creator past 100 - P', () => {
    const reports = [fraud(WALLET_C1), fraud(WALLET_D1)];
    const perfect = Array.from({ length: 40 }, (_, i) =>
      review(i % 2 ? WALLET_B1 : WALLET_C1, { agentId: '2', to: WALLET_A2, value: 100, day: 1 + i / 1000 }));
    const result = score(world([...reports, ...perfect]));
    const creator = creatorOf(result, CREATOR_A);
    expect(creator.P).toBeGreaterThan(19);
    expect(creator.score).toBeLessThanOrEqual(100 - creator.P);
  });
  it('T5.8: the same inputs give the same scores and hash, in any order', () => {
    const reviews = [quality(), fraud(WALLET_C1), fraud(WALLET_D1)];
    const forward = world(reviews);
    const shuffled = { ...world([...reviews].reverse()), agents: [...forward.agents].reverse(), creators: [...forward.creators].reverse() };
    shuffled.reviews[0] = { ...shuffled.reviews[0]!, payment: { ...shuffled.reviews[0]!.payment!, transfers: [...shuffled.reviews[0]!.payment!.transfers].reverse() } };
    const now = at(2);
    expect(computeInputsHash(shuffled, CONFIG, now)).toBe(computeInputsHash(forward, CONFIG, now));
    const hash = computeInputsHash(forward, CONFIG, now);
    expect(buildSnapshot(7, hash, score(shuffled, now))).toEqual(buildSnapshot(7, hash, score(forward, now)));
  });
  it('T5.9: shifting the clock 180 days halves P', () => {
    const reviews = [quality(), fraud(WALLET_C1), fraud(WALLET_D1)];
    const now = score(world(reviews), at(1));
    const later = score(world(reviews), at(181));
    expect(creatorOf(now, CREATOR_A).P).toBe(20);
    expect(creatorOf(later, CREATOR_A).P).toBe(10);
  });
});

describe('circular reviewer weights', () => {
  it('settles deterministically when creators review each other', () => {
    const reviews = [
      review(WALLET_B1, { value: 95, day: 1 }),
      review(WALLET_A1, { agentId: '3', to: WALLET_B1, value: 40, day: 1 }),
      review(WALLET_C1, { agentId: '3', to: WALLET_B1, value: 80, day: 1 }),
      review(WALLET_B1, { agentId: '4', to: WALLET_C1, value: 60, day: 1 }),
      review(WALLET_D1, { value: 20, day: 1 }),
    ];
    const first = score(world(reviews));
    const second = score(world(reviews));
    expect(first.agents).toEqual(second.agents);
    expect(first.creators).toEqual(second.creators);
    expect(first.iterations).toBeLessThanOrEqual(CONFIG.fixedPointIterations);
  });
  it('stops at the iteration limit on any input', () => {
    const reviews = [review(WALLET_B1, { value: 95 }), review(WALLET_A1, { agentId: '3', to: WALLET_B1, value: 5 })];
    expect(computeScores(world(reviews), { ...CONFIG, fixedPointIterations: 1 }, at(2)).iterations).toBe(1);
  });
  it('derives published creators from published agents, even when stopped before settling', () => {
    const reviews = [
      review(WALLET_B1, { value: 95 }),
      review(WALLET_C1, { value: 20 }),
      review(WALLET_A1, { agentId: '3', to: WALLET_B1, value: 40 }),
      review(WALLET_C1, { agentId: '3', to: WALLET_B1, value: 80 }),
    ];
    const result = computeScores(world(reviews), { ...CONFIG, fixedPointIterations: 1 }, at(2));
    expect(creatorOf(result, CREATOR_A).score).toBe(agentOf(result, '1').score);
    expect(creatorOf(result, CREATOR_B).score).toBe(agentOf(result, '3').score);
  });
});

describe('inputsHash', () => {
  const inputs = () => world([review(WALLET_B1, { txId: '0.0.9-1800000000-000000009' })]);
  const pinned = (item: ScoringInputs) => {
    const copy = structuredClone(item);
    copy.reviews.forEach((one) => { one.feedbackIndex = 1; one.logIndex = 1; one.txHash = '0x1'; one.feedbackUri = 'x'; one.fileBase64 = 'e30='; one.feedbackHash = '0x00'; });
    return copy;
  };
  it('changes with a review, the time and the config', () => {
    const base = computeInputsHash(pinned(inputs()), CONFIG, at(2));
    expect(computeInputsHash(pinned(inputs()), CONFIG, at(2))).toBe(base);
    expect(computeInputsHash(pinned(inputs()), CONFIG, at(3))).not.toBe(base);
    expect(computeInputsHash(pinned(inputs()), { ...CONFIG, reviewerWeightFloor: 0.3 }, at(2))).not.toBe(base);
    const changed = pinned(inputs());
    changed.reviews[0]!.revokedAt = at(1.5);
    expect(computeInputsHash(changed, CONFIG, at(2))).not.toBe(base);
  });
  it('sorts keys canonically', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }], e: undefined })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
  });
});

describe('snapshot', () => {
  it('has exactly the published shape', () => {
    const snapshot = buildSnapshot(3, '0xabc', score(world([review(WALLET_B1)])));
    expect(Object.keys(snapshot).sort()).toEqual(['agents', 'configVersion', 'creators', 'epoch', 'epochSeconds', 'inputsHash']);
    expect(Object.keys(snapshot.agents[0]!).sort()).toEqual(['agentId', 'counted', 'excluded', 'score', 'tier']);
    expect(Object.keys(snapshot.creators[0]!).sort()).toEqual(['P', 'creator', 'score']);
  });
  it('says which epoch length its number counts in', () => {
    const custom = computeScores(world([]), { ...CONFIG, epochSeconds: 60 }, at(2));
    expect(buildSnapshot(3, '0xabc', custom).epochSeconds).toBe(60);
  });
  it('flags a non-finite score', () => {
    const snapshot = buildSnapshot(3, '0xabc', score(world([review(WALLET_B1)])));
    expect(hasOnlyFiniteScores(snapshot)).toBe(true);
    expect(hasOnlyFiniteScores({ ...snapshot, creators: [{ ...snapshot.creators[0]!, P: Number.NaN }] })).toBe(false);
    expect(hasOnlyFiniteScores({ ...snapshot, agents: [{ ...snapshot.agents[0]!, score: Infinity }] })).toBe(false);
  });
  it('keeps the last nanosecond of an epoch inside it', () => {
    expect(epochOf('1793966399.999999999', CONFIG)).toBe(498323);
    expect(epochOf('1793966400.000000000', CONFIG)).toBe(498324);
  });
  it('counts HCS chunks by bytes', () => {
    expect(chunksNeeded('x')).toBe(1);
    expect(chunksNeeded('x'.repeat(1024))).toBe(1);
    expect(chunksNeeded('x'.repeat(1025))).toBe(2);
    expect(chunksNeeded('é'.repeat(1024))).toBe(2);
  });
});
