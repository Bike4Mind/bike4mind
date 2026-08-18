import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument, ILakeConfigChangeEventDocument, ILakeConfigFieldChange } from '@bike4mind/common';
import {
  assembleLakeConfigHistory,
  clampLakeConfigHistoryLimit,
  toLakeConfigHistoryEntry,
  LAKE_CONFIG_HISTORY_LIMIT,
  LAKE_CONFIG_HISTORY_MAX_LIMIT,
} from './assembleLakeConfigHistory';

const lake = (over: Partial<IDataLakeDocument> = {}) =>
  ({ id: 'lake1', name: 'Ops Lake', ...over }) as IDataLakeDocument;

const nameChange: ILakeConfigFieldChange = { field: 'name', kind: 'literal', before: 'a', after: 'b' };

const event = (over: Partial<ILakeConfigChangeEventDocument> = {}) =>
  ({
    id: 'evt1',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    principalKind: 'user',
    principalId: '000000000000000000000001',
    manageRung: 'grant-owner',
    action: 'update',
    changes: [nameChange],
    ...over,
  }) as ILakeConfigChangeEventDocument;

const adapters = (
  events: ILakeConfigChangeEventDocument[],
  over: { findByIds?: ReturnType<typeof vi.fn>; limit?: number } = {}
) => {
  const listByLake = vi.fn().mockResolvedValue(events);
  const findByIds = over.findByIds ?? vi.fn().mockResolvedValue([]);
  return {
    listByLake,
    findByIds,
    adapters: {
      db: { lakeConfigChangeEvents: { listByLake }, users: { findByIds } as never },
      limit: over.limit,
      now: new Date('2026-08-18T12:00:00Z'),
    },
  };
};

describe('clampLakeConfigHistoryLimit', () => {
  it('defaults when absent or non-finite, so a garbage query param serves a page rather than throwing', () => {
    expect(clampLakeConfigHistoryLimit(undefined)).toBe(LAKE_CONFIG_HISTORY_LIMIT);
    expect(clampLakeConfigHistoryLimit(Number.NaN)).toBe(LAKE_CONFIG_HISTORY_LIMIT);
    expect(clampLakeConfigHistoryLimit(Number.POSITIVE_INFINITY)).toBe(LAKE_CONFIG_HISTORY_LIMIT);
  });

  it('clamps to the ceiling so a request cannot ask for an unbounded page', () => {
    expect(clampLakeConfigHistoryLimit(LAKE_CONFIG_HISTORY_MAX_LIMIT + 1_000)).toBe(LAKE_CONFIG_HISTORY_MAX_LIMIT);
  });

  it('floors to 1 rather than 0 or negative, which would make listByLake drop its limit entirely', () => {
    expect(clampLakeConfigHistoryLimit(0)).toBe(1);
    expect(clampLakeConfigHistoryLimit(-5)).toBe(1);
  });

  it('truncates a fractional request instead of passing it to the query', () => {
    expect(clampLakeConfigHistoryLimit(10.9)).toBe(10);
  });
});

describe('toLakeConfigHistoryEntry', () => {
  it('carries the audit facts a reader is owed, keyed by the event id', () => {
    expect(toLakeConfigHistoryEntry(event({ manageRung: 'platform-admin', action: 'visibility' }))).toMatchObject({
      eventId: 'evt1',
      principalKind: 'user',
      manageRung: 'platform-admin',
      action: 'visibility',
      changes: [nameChange],
    });
  });
});

describe('assembleLakeConfigHistory', () => {
  it('returns entries newest-first as listByLake ordered them, without re-sorting or aggregating', async () => {
    const newer = event({ id: 'evt2', createdAt: new Date('2026-08-05T00:00:00Z') });
    const older = event({ id: 'evt1', createdAt: new Date('2026-08-01T00:00:00Z') });
    const { adapters: a } = adapters([newer, older]);
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view.entries.map(e => e.eventId)).toEqual(['evt2', 'evt1']);
  });

  it('keeps two changes by the same principal as SEPARATE rows - collapsing them would destroy the before -> after chain', async () => {
    const { adapters: a } = adapters([event({ id: 'evt2' }), event({ id: 'evt1' })]);
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view.entries).toHaveLength(2);
  });

  it('reads the clamped page size, not the raw request', async () => {
    const { listByLake, adapters: a } = adapters([], { limit: LAKE_CONFIG_HISTORY_MAX_LIMIT + 50 });
    await assembleLakeConfigHistory(lake(), a);
    expect(listByLake).toHaveBeenCalledWith('lake1', { limit: LAKE_CONFIG_HISTORY_MAX_LIMIT });
  });

  it('is empty and untruncated for a lake whose history predates the feature', async () => {
    const { adapters: a } = adapters([]);
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view.entries).toEqual([]);
    expect(view.truncated).toBe(false);
    expect(view.windowStartsAt).toBeUndefined();
  });

  describe('truncation', () => {
    it('flags a full page and carries the window start, so a partial list is never read as all-time', async () => {
      const events = [
        event({ id: 'a', createdAt: new Date('2026-08-05T00:00:00Z') }),
        event({ id: 'b', createdAt: new Date('2026-08-01T00:00:00Z') }),
      ];
      const { adapters: a } = adapters(events, { limit: 2 });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.truncated).toBe(true);
      expect(view.windowStartsAt).toEqual(new Date('2026-08-01T00:00:00Z'));
    });

    it('does not flag a partial page', async () => {
      const { adapters: a } = adapters([event()], { limit: 2 });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.truncated).toBe(false);
    });
  });

  describe('principal name resolution', () => {
    it('resolves a user principal and the on-behalf human in ONE batched lookup', async () => {
      const findByIds = vi.fn().mockResolvedValue([
        { id: '000000000000000000000001', name: 'Ada' },
        { id: '000000000000000000000002', name: 'Grace' },
      ]);
      const { adapters: a } = adapters(
        [
          event({
            principalKind: 'apiKey',
            principalId: 'key_abc',
            onBehalfOfUserId: '000000000000000000000002',
          }),
          event({ id: 'evt2', principalId: '000000000000000000000001' }),
        ],
        { findByIds }
      );
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(findByIds).toHaveBeenCalledTimes(1);
      expect(view.entries[0].onBehalfOfName).toBe('Grace');
      expect(view.entries[1].principalName).toBe('Ada');
    });

    it('does not look up a non-user principal - "system" is what a write no principal drove records', async () => {
      const { findByIds, adapters: a } = adapters([event({ principalKind: 'system', principalId: 'system' })]);
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(findByIds).not.toHaveBeenCalled();
      expect(view.entries[0].principalName).toBeUndefined();
    });

    // The two below pin the SHAPE guard specifically, which the principalKind check cannot cover:
    // findByIds throws on a non-24-hex id, so an unguarded one 500s the entire history.
    it('does not look up a user-kind principal whose id is not ObjectId-shaped', async () => {
      const { findByIds } = adapters([]);
      const { adapters: a } = adapters([event({ principalKind: 'user', principalId: 'legacy-principal' })], {
        findByIds,
      });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(findByIds).not.toHaveBeenCalled();
      expect(view.entries[0].principalName).toBeUndefined();
    });

    it('does not look up a non-ObjectId onBehalfOfUserId - it carries no principalKind to filter on', async () => {
      const { findByIds } = adapters([]);
      const { adapters: a } = adapters(
        [event({ principalKind: 'apiKey', principalId: 'key_abc', onBehalfOfUserId: 'not-an-object-id' })],
        { findByIds }
      );
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(findByIds).not.toHaveBeenCalled();
      expect(view.entries[0].onBehalfOfName).toBeUndefined();
    });

    it('leaves an unresolvable user as its opaque id rather than inventing a name', async () => {
      const { adapters: a } = adapters([event()], { findByIds: vi.fn().mockResolvedValue([]) });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.entries[0].principalName).toBeUndefined();
      expect(view.entries[0].principalId).toBe('000000000000000000000001');
    });

    it('falls back to username, and NEVER to email - a cross-tenant address must not leak as a name', async () => {
      const findByIds = vi
        .fn()
        .mockResolvedValue([{ id: '000000000000000000000001', username: 'ada', email: 'ada@example.com' }]);
      const { adapters: a } = adapters([event()], { findByIds });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.entries[0].principalName).toBe('ada');
    });

    it('does not name a non-user principal even when its id happens to be ObjectId-shaped', async () => {
      const findByIds = vi.fn().mockResolvedValue([{ id: '000000000000000000000001', name: 'Ada' }]);
      const { adapters: a } = adapters([event({ principalKind: 'agent', principalId: '000000000000000000000001' })], {
        findByIds,
      });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.entries[0].principalName).toBeUndefined();
    });
  });

  it('skips the user lookup entirely when no id is resolvable', async () => {
    const { findByIds, adapters: a } = adapters([]);
    await assembleLakeConfigHistory(lake(), a);
    expect(findByIds).not.toHaveBeenCalled();
  });

  it('stamps the injected clock and echoes the lake identity for the surface header', async () => {
    const { adapters: a } = adapters([]);
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view).toMatchObject({
      lakeId: 'lake1',
      lakeName: 'Ops Lake',
      generatedAt: new Date('2026-08-18T12:00:00Z'),
    });
  });
});
