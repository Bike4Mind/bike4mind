import { describe, expect, it } from 'vitest';
import { SessionCreatedAction } from './actions';

/**
 * `taggedAt` is carried on this action only for parity with the Session schema path of the same
 * name - no emitter populates it today, and no runtime code calls `.parse` on this schema (it is
 * consumed through `z.infer`). That makes the entry easy to delete by accident, so these pin the
 * two things a reader would otherwise have to re-derive: it survives a round trip as a Date, and
 * it is optional, so an emitter that omits it is still valid.
 */
const frame = (overrides: Record<string, unknown> = {}) => ({
  action: 'session.created',
  id: 'session-1',
  name: 'Notebook',
  userId: 'user-1',
  lastUpdated: new Date('2026-05-01T00:00:00.000Z'),
  firstCreated: new Date('2026-05-01T00:00:00.000Z'),
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
  isGlobalRead: false,
  isGlobalWrite: false,
  users: [],
  groups: [],
  ...overrides,
});

describe('SessionCreatedAction taggedAt parity', () => {
  it('round-trips taggedAt as a Date', () => {
    const taggedAt = new Date('2026-05-01T12:34:56.000Z');

    expect(SessionCreatedAction.parse(frame({ taggedAt })).taggedAt).toEqual(taggedAt);
  });

  it('is optional, so an emitter that omits it still parses', () => {
    expect(SessionCreatedAction.parse(frame()).taggedAt).toBeUndefined();
  });

  it('rejects a non-Date, which is what keeps it in step with the schema path', () => {
    expect(() => SessionCreatedAction.parse(frame({ taggedAt: '2026-05-01' }))).toThrow();
  });
});
