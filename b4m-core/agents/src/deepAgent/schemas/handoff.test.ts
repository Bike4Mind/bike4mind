import { describe, it, expect } from 'vitest';
import { HandoffSchema, measureHandoffSizeBytes, type Handoff } from './handoff';

const ISO = '2026-06-08T00:00:00.000Z';

function minimalHandoffInput() {
  return {
    agentId: 'agent-1',
    wakeCount: 0,
    lastWakeAt: ISO,
    updatedAt: ISO,
  };
}

describe('HandoffSchema defaults', () => {
  it('defaults the prose + blocker fields to empty', () => {
    const handoff = HandoffSchema.parse(minimalHandoffInput());
    expect(handoff.lastActionSummary).toBe('');
    expect(handoff.nextIntendedAction).toBe('');
    expect(handoff.openBlockers).toEqual([]);
    expect(handoff.nextWakeIntervalMs).toBeUndefined();
    expect(handoff.lastEpisodeId).toBeUndefined();
  });
});

describe('HandoffSchema validation', () => {
  it('requires a non-negative integer wakeCount', () => {
    expect(HandoffSchema.safeParse({ ...minimalHandoffInput(), wakeCount: -1 }).success).toBe(false);
    expect(HandoffSchema.safeParse({ ...minimalHandoffInput(), wakeCount: 1.5 }).success).toBe(false);
  });

  it('requires a positive nextWakeIntervalMs when present', () => {
    expect(HandoffSchema.safeParse({ ...minimalHandoffInput(), nextWakeIntervalMs: 0 }).success).toBe(false);
    expect(HandoffSchema.safeParse({ ...minimalHandoffInput(), nextWakeIntervalMs: 60_000 }).success).toBe(true);
  });

  it('rejects a non-datetime lastWakeAt', () => {
    expect(HandoffSchema.safeParse({ ...minimalHandoffInput(), lastWakeAt: 'soon' }).success).toBe(false);
  });
});

describe('measureHandoffSizeBytes', () => {
  it('matches the serialized JSON byte length', () => {
    const handoff: Handoff = HandoffSchema.parse(minimalHandoffInput());
    expect(measureHandoffSizeBytes(handoff)).toBe(Buffer.byteLength(JSON.stringify(handoff), 'utf8'));
  });

  it('a fast-changing handoff stays small relative to a charter budget', () => {
    const handoff: Handoff = HandoffSchema.parse({
      ...minimalHandoffInput(),
      lastActionSummary: 'Ran the proxy DSF probe; matched the analytic formula within 4%.',
      nextIntendedAction: 'Scale to paper-sized graph and compare against Fig. 2D.',
    });
    expect(measureHandoffSizeBytes(handoff)).toBeLessThan(8 * 1024);
  });
});
