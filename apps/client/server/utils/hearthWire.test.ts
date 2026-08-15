import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureActorMock } = vi.hoisted(() => ({ ensureActorMock: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  hearthRepository: { ensureActor: ensureActorMock },
  MAX_PRESENCE_FIELD_LENGTH: 200,
}));

import {
  toWireHearthEvent,
  toWireHearthPresence,
  wireActorIdentity,
  resolveRequestActor,
  HearthSessionParamSchema,
  HearthActorParamSchema,
} from './hearthWire';

const EVENT = {
  id: 'e1',
  channelId: 'ch-1',
  seq: 7,
  actorId: 'actor-1',
  kind: 'message' as const,
  human: { text: 'hi', format: 'md' as const },
  refs: {},
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const ROW = {
  actorId: { toString: () => 'actor-1' },
  state: 'running',
  lastSeen: new Date('2026-01-01T00:00:00.000Z'),
} as unknown as Parameters<typeof toWireHearthPresence>[0];

const USER = { id: 'u1', username: 'erik' };

beforeEach(() => {
  vi.clearAllMocks();
  ensureActorMock.mockResolvedValue({ _id: { toString: () => 'actor-1' }, displayName: 'erik', kind: 'human' });
});

// actorKind is the visible half of the actor-spoofing mitigation, so the wire
// functions that carry the trustworthy value are asserted directly rather than
// only through fixtures the components hand-inject.
describe('actor identity on the wire', () => {
  it('carries the resolved kind onto an event', () => {
    const wire = toWireHearthEvent(EVENT, { displayName: 'agent one', kind: 'agent' });
    expect(wire).toMatchObject({ actorName: 'agent one', actorKind: 'agent' });
  });

  it('carries the resolved kind onto a roster row', () => {
    const wire = toWireHearthPresence(ROW, { displayName: 'agent one', kind: 'agent' });
    expect(wire).toMatchObject({ actorName: 'agent one', actorKind: 'agent' });
  });

  it('leaves both undefined when no actor was resolved, rather than guessing a kind', () => {
    expect(toWireHearthEvent(EVENT).actorKind).toBeUndefined();
    expect(toWireHearthEvent(EVENT).actorName).toBeUndefined();
    expect(toWireHearthPresence(ROW).actorKind).toBeUndefined();
  });

  // Must match actorIdentitiesById's preference, or the same event renders under
  // the slug live and under the friendly label once it returns via catchup.
  it('prefers the friendly label over the identity name', () => {
    expect(wireActorIdentity({ displayName: 'erik (a1b2)', displayLabel: 'erik (my nb)', kind: 'human' })).toEqual({
      displayName: 'erik (my nb)',
      kind: 'human',
    });
    expect(wireActorIdentity({ displayName: 'erik (a1b2)', kind: 'human' })).toEqual({
      displayName: 'erik (a1b2)',
      kind: 'human',
    });
  });
});

describe('resolveRequestActor', () => {
  it('defaults to a human actor named from the account', async () => {
    await resolveRequestActor(USER, undefined, undefined);
    expect(ensureActorMock).toHaveBeenCalledWith('u1', 'human', 'erik');
  });

  it('honors a session kind while keeping the name server-derived', async () => {
    await resolveRequestActor(USER, undefined, { id: 'sess-1', kind: 'agent' });
    const [userId, kind, name] = ensureActorMock.mock.calls[0];
    expect([userId, kind]).toEqual(['u1', 'agent']);
    // The authenticated username stays the prefix: a session cannot name itself.
    expect(name.startsWith('erik (')).toBe(true);
  });

  it('keeps one actor per session across kinds of call, label or not', async () => {
    await resolveRequestActor(USER, undefined, { id: 'sess-1', kind: 'agent' });
    await resolveRequestActor(USER, undefined, { id: 'sess-1', label: 'my nb', kind: 'agent' });
    const [, , bare] = ensureActorMock.mock.calls[0];
    const [, , labelled, options] = ensureActorMock.mock.calls[1];
    expect(labelled).toBe(bare);
    expect(options).toEqual({ displayLabel: 'erik (my nb)' });
  });

  it('reserves human and system on both self-identification paths', () => {
    for (const kind of ['human', 'system']) {
      expect(HearthSessionParamSchema.safeParse({ id: 'sess-1', kind }).success).toBe(false);
      expect(HearthActorParamSchema.safeParse({ displayName: 'erik', kind }).success).toBe(false);
    }
    for (const kind of ['agent', 'gateway', 'device']) {
      expect(HearthSessionParamSchema.safeParse({ id: 'sess-1', kind }).success).toBe(true);
      expect(HearthActorParamSchema.safeParse({ displayName: 'erik', kind }).success).toBe(true);
    }
  });
});
