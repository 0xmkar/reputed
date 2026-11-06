/** Hedera consensus timestamps are "seconds.nanos" strings; floats would lose the nanos. */
export type ConsensusTimestamp = string;

export const SECONDS_PER_DAY = 86_400;

export function toNanos(ts: ConsensusTimestamp): bigint {
  const [seconds = '0', nanos = ''] = ts.split('.');
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos.padEnd(9, '0').slice(0, 9));
}

export function compareConsensus(a: ConsensusTimestamp, b: ConsensusTimestamp): number {
  const x = toNanos(a);
  const y = toNanos(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function fromSeconds(seconds: number): ConsensusTimestamp {
  return `${Math.floor(seconds)}.000000000`;
}

export function fromMillis(ms: number): ConsensusTimestamp {
  const whole = Math.floor(ms);
  return `${Math.floor(whole / 1000)}.${String((whole % 1000) * 1_000_000).padStart(9, '0')}`;
}

export function addDays(ts: ConsensusTimestamp, days: number): ConsensusTimestamp {
  const nanos = toNanos(ts) + BigInt(Math.round(days * SECONDS_PER_DAY)) * 1_000_000_000n;
  return `${nanos / 1_000_000_000n}.${String(nanos % 1_000_000_000n).padStart(9, '0')}`;
}

export function ageInDays(from: ConsensusTimestamp, now: ConsensusTimestamp): number {
  return Math.max(0, Number(toNanos(now) - toNanos(from)) / 1e9 / SECONDS_PER_DAY);
}

export function toIso(ts: ConsensusTimestamp): string {
  return new Date(Number(toNanos(ts) / 1_000_000n)).toISOString();
}
