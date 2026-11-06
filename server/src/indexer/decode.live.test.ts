import { REPUTATION_REGISTRY, HEDERA_TESTNET } from '@reputed/shared';
import { describe, expect, it } from 'vitest';
import { decodeLog } from './decode.ts';
import { foldEvents } from './fold.ts';
import { MirrorClient } from './mirror.ts';

// Read-only against the public testnet Mirror Node. Run with LIVE=1.
describe.skipIf(!process.env['LIVE'])('live decode', () => {
  it('decodes every NewFeedback in the real Reputation Registry', async () => {
    const mirror = new MirrorClient({ baseUrl: HEDERA_TESTNET.mirrorNode });
    let path: string | null = mirror.firstLogsPath(REPUTATION_REGISTRY, null);
    let total = 0;
    const events = [];
    while (path) {
      const page = await mirror.logsPage(path);
      total += page.logs.length;
      events.push(...page.logs.flatMap((log) => decodeLog('reputation', log) ?? []));
      path = page.next;
    }
    const state = foldEvents(events);
    const newest = state.feedback.at(-1)!;
    console.info(`logs ${total}, decoded ${events.length}, feedback ${state.feedback.length}`);
    console.info(JSON.stringify({ ...newest, feedbackUri: newest.feedbackUri.slice(0, 60) }));
    expect(state.feedback.length).toBeGreaterThan(0);
    expect(newest.feedbackIndex).toBeGreaterThanOrEqual(1);
    expect(newest.client).toMatch(/^0x[0-9a-f]{40}$/);
  }, 60_000);
});
