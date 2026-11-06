import { encodeAbiParameters, encodeEventTopics, pad, toHex, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { identityRegistryAbi } from '../src/abi/identityRegistry';
import { IDENTITY_REGISTRY } from '../src/constants';
import { creatorRegistryAbi } from '../src/abi/creatorRegistry';
import { agentIdFromLogs, agentUriFromLog, REGISTERED, serialFromLogs } from '../src/logs';

const owner = '0x2222222222222222222222222222222222222222';

function registeredLog(agentId: bigint, uri: string) {
  return {
    address: IDENTITY_REGISTRY,
    topics: encodeEventTopics({ abi: identityRegistryAbi, eventName: 'Registered', args: { agentId, owner } }) as Hex[],
    data: encodeAbiParameters([{ type: 'string' }], [uri]),
  };
}

describe('registration logs', () => {
  it('reads the agent id, including 0', () => {
    expect(agentIdFromLogs([registeredLog(0n, 'a')])).toBe('0');
    expect(agentIdFromLogs([registeredLog(166n, 'a')])).toBe('166');
  });

  it('reads the URI', () => {
    expect(agentUriFromLog(registeredLog(1n, 'data:x'))).toBe('data:x');
  });

  it('ignores logs from other contracts', () => {
    const log = { ...registeredLog(5n, 'a'), address: '0x3333333333333333333333333333333333333333' };
    expect(agentIdFromLogs([log])).toBeNull();
  });

  it('falls back to the mint Transfer', () => {
    const transfer = {
      address: IDENTITY_REGISTRY,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        pad('0x0', { size: 32 }),
        pad(owner, { size: 32 }),
        pad(toHex(9n), { size: 32 }),
      ],
      data: '0x',
    };
    expect(agentIdFromLogs([transfer])).toBe('9');
    expect(REGISTERED).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('reads the serial of the named agent only', () => {
    const registry = '0x4444444444444444444444444444444444444444';
    const linked = (agentId: bigint, serial: bigint) => ({
      address: registry,
      topics: encodeEventTopics({
        abi: creatorRegistryAbi,
        eventName: 'AgentLinked',
        args: { agentId, creator: owner, agentWallet: owner },
      }) as Hex[],
      data: encodeAbiParameters([{ type: 'int64' }], [serial]),
    });
    const logs = [linked(1n, 11n), linked(2n, 22n)];
    expect(serialFromLogs(logs, registry, '2')).toBe(22);
    expect(serialFromLogs(logs, registry, '1')).toBe(11);
    expect(serialFromLogs(logs, registry, '3')).toBeNull();
    expect(serialFromLogs(logs, '0x5555555555555555555555555555555555555555', '1')).toBeNull();
  });
});
