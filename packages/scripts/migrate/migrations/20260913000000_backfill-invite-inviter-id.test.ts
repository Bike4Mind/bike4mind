import { describe, it, expect, vi, beforeEach } from 'vitest';

type Filter = Record<string, unknown>;
type InviteRow = { _id: string; username?: string; documentId?: string };
type SessionRow = { _id: string; userId?: string; users?: Array<{ userId?: string }> };

const mockInviteFind = vi.fn<(filter: Filter) => InviteRow[]>();
const mockInviteBulkWrite = vi.fn<(writes: unknown[]) => Promise<{ modifiedCount: number }>>();
const mockUserFind = vi.fn<(filter: Filter) => Array<{ _id: string; username?: string }>>();
const mockSessionFind = vi.fn<(filter: Filter) => SessionRow[]>();

vi.mock('@bike4mind/database', () => ({
  Invite: {
    // Mirrors the real chain: find().sort().limit().select() resolves to the rows.
    find: (filter: Filter) => {
      const rows = mockInviteFind(filter);
      const chain = { sort: () => chain, limit: () => chain, select: () => Promise.resolve(rows) };
      return chain;
    },
    bulkWrite: (writes: unknown[]) => mockInviteBulkWrite(writes),
  },
  User: {
    find: (filter: Filter) => ({ select: () => Promise.resolve(mockUserFind(filter)) }),
  },
  Session: {
    find: (filter: Filter) => ({ select: () => Promise.resolve(mockSessionFind(filter)) }),
  },
}));

import migration from './20260913000000_backfill-invite-inviter-id';

let logged: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  mockInviteFind.mockReturnValue([]);
  mockUserFind.mockReturnValue([]);
  // Default: every invite in a test's batch targets a session the resolved account owns, so a test
  // that is not about corroboration does not have to restate it.
  mockSessionFind.mockImplementation(filter => {
    const ids = ((filter._id as { $in?: string[] })?.$in ?? []) as string[];
    return ids.map(id => ({ _id: id, userId: 'u-alice', users: [] }));
  });
  mockInviteBulkWrite.mockImplementation(async writes => ({ modifiedCount: writes.length }));
});

const output = () => logged.join('\n');

describe('backfill-invite-inviter-id', () => {
  it('sets inviterId on every invite whose username resolves to exactly one account', async () => {
    mockInviteFind.mockReturnValueOnce([
      { _id: 'i1', username: 'alice', documentId: 's1' },
      { _id: 'i2', username: 'alice', documentId: 's1' },
    ]);
    mockUserFind.mockReturnValue([{ _id: 'u-alice', username: 'alice' }]);

    await migration.up();

    expect(mockInviteBulkWrite).toHaveBeenCalledTimes(1);
    expect(mockInviteBulkWrite).toHaveBeenCalledWith([
      { updateOne: { filter: { _id: 'i1' }, update: { $set: { inviterId: 'u-alice' } } } },
      { updateOne: { filter: { _id: 'i2' }, update: { $set: { inviterId: 'u-alice' } } } },
    ]);
    expect(output()).toContain('set inviterId on 2 Session invite(s)');
  });

  // Username uniqueness on this schema is case-SENSITIVE, so one string can legitimately match two
  // real accounts. Guessing would widen what acceptance propagates, so the row stays on the fallback.
  it('skips an ambiguous username rather than attributing the invite to one of the matches', async () => {
    mockInviteFind.mockReturnValueOnce([{ _id: 'i1', username: 'alice', documentId: 's1' }]);
    mockUserFind.mockReturnValue([
      { _id: 'u-1', username: 'alice' },
      { _id: 'u-2', username: 'alice' },
    ]);

    await migration.up();

    expect(mockInviteBulkWrite).not.toHaveBeenCalled();
    expect(output()).toContain('1 username(s) skipped as unresolvable or ambiguous');
  });

  it('skips a username with no account at all', async () => {
    mockInviteFind.mockReturnValueOnce([{ _id: 'i1', username: 'ghost', documentId: 's1' }]);
    mockUserFind.mockReturnValue([]);

    await migration.up();

    expect(mockInviteBulkWrite).not.toHaveBeenCalled();
    expect(output()).toContain('1 username(s) skipped');
  });

  // The point of the batching: a full page must advance the _id cursor and come back for more,
  // and a short page must end the scan rather than spinning on the same rows.
  it('pages forward on a full batch and stops on a short one', async () => {
    const fullBatch: InviteRow[] = Array.from({ length: 1000 }, (_, i) => ({
      _id: `i${i}`,
      username: 'alice',
      documentId: 's1',
    }));
    mockInviteFind
      .mockReturnValueOnce(fullBatch)
      .mockReturnValueOnce([{ _id: 'i1000', username: 'alice', documentId: 's1' }]);
    mockUserFind.mockReturnValue([{ _id: 'u-alice', username: 'alice' }]);

    await migration.up();

    expect(mockInviteFind).toHaveBeenCalledTimes(2);
    expect(mockInviteFind.mock.calls[0][0]._id).toBeUndefined();
    expect(mockInviteFind.mock.calls[1][0]._id).toEqual({ $gt: 'i999' });
    // One User lookup, not one per batch: the resolution cache spans the scan.
    expect(mockUserFind).toHaveBeenCalledTimes(1);
    expect(output()).toContain('set inviterId on 1001 Session invite(s)');
  });

  it('reports nothing to do when no invite is missing inviterId', async () => {
    await migration.up();

    expect(mockInviteBulkWrite).not.toHaveBeenCalled();
    expect(output()).toContain('set inviterId on 0 Session invite(s)');
  });

  // `username` is mutable and the only reader of `inviterId` is an authorization gate, so a
  // rename-then-reuse must not be attributed. It resolves to exactly one account, so the ambiguity
  // guard never sees it - the session principal check is what catches it.
  it('skips a username that now belongs to someone who does not own the session', async () => {
    mockInviteFind.mockReturnValueOnce([{ _id: 'i1', username: 'alice', documentId: 's1' }]);
    mockUserFind.mockReturnValue([{ _id: 'u-squatter', username: 'alice' }]);
    mockSessionFind.mockReturnValue([{ _id: 's1', userId: 'u-original', users: [] }]);

    await migration.up();

    expect(mockInviteBulkWrite).not.toHaveBeenCalled();
    expect(output()).toContain('1 invite(s) skipped because the resolved account does not own the session');
  });

  // Minting a Session invite is owner-only, so a grant holder is never the inviter. Admitting one
  // would readmit the squatter the narrowing exists to exclude: a renamed-into account that happens
  // to hold a grant would get `inviterId` and then gate propagation on its own permissions.
  it('skips a resolved account that only holds a grant on the session', async () => {
    mockInviteFind.mockReturnValueOnce([{ _id: 'i1', username: 'alice', documentId: 's1' }]);
    mockUserFind.mockReturnValue([{ _id: 'u-alice', username: 'alice' }]);
    mockSessionFind.mockReturnValue([{ _id: 's1', userId: 'u-owner', users: [{ userId: 'u-alice' }] }]);

    await migration.up();

    expect(mockInviteBulkWrite).not.toHaveBeenCalled();
    expect(output()).toContain('1 invite(s) skipped because the resolved account does not own the session');
  });

  // Every other invite type would be written for no reader at all, so the scan never sees them.
  it('scans Session invites only', async () => {
    await migration.up();

    expect(mockInviteFind.mock.calls[0][0].type).toBe('Session');
  });
});
