import { describe, expect, it } from 'vitest';
import { LiveActivityPushEventSchema } from './liveActivityPush';

const base = { userId: 'u1', questId: 'q1', event: 'update' as const, contentState: { status: 'running' } };

describe('LiveActivityPushEventSchema', () => {
  it('round-trips a full event', () => {
    const full = {
      ...base,
      contentState: { status: 'running', stageLabel: 'Searching', progress: 0.5, errored: false },
      staleDate: 1_800_000_000,
      dismissalDate: 1_800_000_100,
    };
    expect(LiveActivityPushEventSchema.parse(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });

  it('accepts the minimal end event', () => {
    expect(LiveActivityPushEventSchema.parse({ ...base, event: 'end' }).event).toBe('end');
  });

  it.each([
    ['unknown event', { ...base, event: 'start' }],
    ['progress above 1', { ...base, contentState: { status: 'running', progress: 1.2 } }],
    ['progress below 0', { ...base, contentState: { status: 'running', progress: -0.1 } }],
    ['empty status', { ...base, contentState: { status: '' } }],
    ['missing questId', { ...base, questId: '' }],
    ['fractional staleDate', { ...base, staleDate: 1.5 }],
  ])('rejects %s', (_label, input) => {
    expect(LiveActivityPushEventSchema.safeParse(input).success).toBe(false);
  });
});
