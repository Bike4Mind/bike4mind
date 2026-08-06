import { describe, it, expect, vi, beforeEach } from 'vitest';

type Filter = Record<string, unknown>;

const mockFabFileLean = vi.fn<() => Promise<unknown[]>>();
const mockFabFileSelect = vi.fn<(fields: string) => { lean: typeof mockFabFileLean }>(() => ({
  lean: mockFabFileLean,
}));
const mockFabFileFind = vi.fn<(filter: Filter) => { select: typeof mockFabFileSelect }>(() => ({
  select: mockFabFileSelect,
}));

const mockSessionLean = vi.fn<() => Promise<unknown[]>>();
const mockSessionSetOptions = vi.fn<(opts: Filter) => { lean: typeof mockSessionLean }>(() => ({
  lean: mockSessionLean,
}));
const mockSessionSelect = vi.fn<(fields: string) => { setOptions: typeof mockSessionSetOptions }>(() => ({
  setOptions: mockSessionSetOptions,
}));
const mockSessionFind = vi.fn<(filter: Filter) => { select: typeof mockSessionSelect }>(() => ({
  select: mockSessionSelect,
}));

vi.mock('@bike4mind/database', () => ({
  FabFile: { find: (filter: Filter) => mockFabFileFind(filter) },
  Session: { find: (filter: Filter) => mockSessionFind(filter) },
}));

import migration, { findOwnerMismatches } from './20260806000000_audit-fabfile-session-owner-mismatch';

const fabFile = (over: Record<string, unknown> = {}) => ({
  _id: 'f1',
  userId: 'u1',
  sessionId: 's1',
  fileName: 'Notebook Summary.txt',
  createdAt: new Date('2026-08-01T00:00:00Z'),
  ...over,
});

describe('findOwnerMismatches', () => {
  it('excludes a FabFile whose userId matches its session owner', () => {
    const result = findOwnerMismatches([fabFile({ userId: 'u1' })], new Map([['s1', 'u1']]));

    expect(result.mismatches).toEqual([]);
    expect(result.orphanedSessionIds).toEqual([]);
  });

  it('flags a FabFile whose userId disagrees with its session owner', () => {
    const result = findOwnerMismatches([fabFile({ userId: 'u2' })], new Map([['s1', 'u1']]));

    expect(result.mismatches).toEqual([
      {
        fabFileId: 'f1',
        sessionId: 's1',
        fabFileUserId: 'u2',
        sessionUserId: 'u1',
        fileName: 'Notebook Summary.txt',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      },
    ]);
  });

  it('tracks a sessionId with no matching Session doc as orphaned, not as a mismatch', () => {
    const result = findOwnerMismatches([fabFile({ sessionId: 'ghost' })], new Map());

    expect(result.mismatches).toEqual([]);
    expect(result.orphanedSessionIds).toEqual(['ghost']);
  });

  it('handles several FabFiles independently', () => {
    const result = findOwnerMismatches(
      [
        fabFile({ _id: 'match', userId: 'u1', sessionId: 's1' }),
        fabFile({ _id: 'mismatch', userId: 'u2', sessionId: 's1' }),
        fabFile({ _id: 'orphan', userId: 'u3', sessionId: 's2' }),
      ],
      new Map([['s1', 'u1']])
    );

    expect(result.mismatches.map(m => m.fabFileId)).toEqual(['mismatch']);
    expect(result.orphanedSessionIds).toEqual(['s2']);
  });

  it('returns nothing for an empty collection', () => {
    expect(findOwnerMismatches([], new Map())).toEqual({ mismatches: [], orphanedSessionIds: [] });
  });

  it('deduplicates repeated orphaned sessionIds', () => {
    const result = findOwnerMismatches(
      [fabFile({ _id: 'a', sessionId: 'ghost' }), fabFile({ _id: 'b', sessionId: 'ghost' })],
      new Map()
    );

    expect(result.orphanedSessionIds).toEqual(['ghost']);
  });
});

const SID1 = '507f1f77bcf86cd799439011';

describe('audit-fabfile-session-owner-mismatch migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes the FabFile read to non-deleted rows with a real sessionId', async () => {
    mockFabFileLean.mockResolvedValue([]);

    await migration.up();

    expect(mockFabFileFind).toHaveBeenCalledWith({ deletedAt: null, sessionId: { $exists: true, $nin: [null, ''] } });
    expect(mockFabFileSelect).toHaveBeenCalledWith('userId sessionId fileName createdAt');
    expect(mockSessionFind).not.toHaveBeenCalled();
  });

  it('reads sessions with includeDeleted, so a since-deleted session still resolves an owner', async () => {
    mockFabFileLean.mockResolvedValue([fabFile({ sessionId: SID1 })]);
    mockSessionLean.mockResolvedValue([{ _id: SID1, userId: 'u1' }]);

    await migration.up();

    expect(mockSessionFind).toHaveBeenCalledWith({ _id: { $in: [SID1] } });
    expect(mockSessionSetOptions).toHaveBeenCalledWith({ includeDeleted: true });
  });

  it('dedupes sessionIds shared by multiple FabFiles before querying sessions', async () => {
    mockFabFileLean.mockResolvedValue([fabFile({ _id: 'a', sessionId: SID1 }), fabFile({ _id: 'b', sessionId: SID1 })]);
    mockSessionLean.mockResolvedValue([{ _id: SID1, userId: 'u1' }]);

    await migration.up();

    expect(mockSessionFind).toHaveBeenCalledWith({ _id: { $in: [SID1] } });
  });

  it('drops a malformed (non-ObjectId) sessionId before querying Session.find, and logs it separately', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockFabFileLean.mockResolvedValue([
      fabFile({ _id: 'good', sessionId: SID1 }),
      fabFile({ _id: 'bad', sessionId: 'not-an-object-id' }),
    ]);
    mockSessionLean.mockResolvedValue([{ _id: SID1, userId: 'u1' }]);

    await migration.up();

    expect(mockSessionFind).toHaveBeenCalledWith({ _id: { $in: [SID1] } });
    expect(logSpy.mock.calls.map(c => c[0]).join('\n')).toContain('not-an-object-id');
    logSpy.mockRestore();
  });

  it('down is a no-op (read-only)', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
    expect(mockFabFileFind).not.toHaveBeenCalled();
  });
});
