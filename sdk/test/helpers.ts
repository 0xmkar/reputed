import type { AgentDetail } from '@reputed/shared';

const ADDR = '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const;

/** A test fixture, not app data. */
export function agentFixture(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agentId: '7', name: 'Alpha', description: 'Does things', tags: [], owner: ADDR, wallet: ADDR, creator: ADDR,
    humanBacked: true, score: { value: 80, tier: 'Tier 1', isNew: false }, creatorScore: 70, reviewsCounted: 3,
    registeredAt: '2026-11-01T00:00:00Z', acceptsX402: false, status: 'active', endpoints: {}, agentUri: 'hcs://0.0.1/1',
    operatorChanged: false, credentials: [], reviews: [], reviewsExcluded: 0, penaltiesConfirmed: 0,
    updatedAt: '2026-11-06T00:00:00Z', scoresStale: false, ...over,
  };
}

/** A fetch that answers every request with the given status and JSON body, and records the URLs. */
export function fakeFetch(status: number, body: unknown) {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: impl, urls };
}
