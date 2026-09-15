import { describe, it, expect, vi, beforeEach } from 'vitest';

type Filter = Record<string, unknown>;
type InviteRow = { _id: string; username?: string };

const mockInviteFind = vi.fn<(filter: Filter) => InviteRow[]>();
const mockInviteBulkWrite = vi.fn<(writes: unknown[]) => Promise<{ modifiedCount: number }>>();
const mockUserFind = vi.fn<(filter: Filter) => Array<{ _id: string; username?: string }>>();

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
  mockInviteBulkWrite.mockImplementation(async writes => ({ modifiedCount: writes.length }));
});

const output = () => logged.join('\n');

describe('backfill-invite-inviter-id', () => {
  it('sets inviterId on every invite whose username resolves to exactly one account', async () => {
    mockInviteFind.mockReturnValueOnce([
      { _id: 'i1', username: 'alice' },
      { _id: 'i2', username: 'alice' },
    ]);
    mockUserFind.mockReturnValue([{ _id: 'u-alice', username: 'alice' }]);

    await migration.up();

    expect(mockInviteBulkWrite).toHaveBeenCalledTimes(1);
    expect(mockInviteBulkWrite).toHaveBeenCalledWith([
      { updateOne: { filter: { _id: 'i1' }, update: { $set: { inviterId: 'u-alice' } } } },
      { updateOne: { filter: { _id: 'i2' }, update: { $set: { inviterId: 'u-alice' } } } },
    ]);
    expect(output()).toContain('set inviterId on 2 invite(s)');
  });

  // Username uniqueness on this schema is case-SENSITIVE, so one string can legitimately match two
  // real accounts. Guessing would widen what acceptance propagates, so the row stays on the fallback.
  it('skips an ambiguous username rather than attributing the invite to one of the matches', async () => {
    mockInviteFind.mockReturnValueOnce([{ _id: 'i1', username: 'alice' }]);
    mockUserFind.mockReturnValue([
      { _id: 'u-1', username: 'alice' },
      { _id: 'u-2', username: 'alice' },
    ]);

    await migration.up();

    expect(mockInviteBulkWrite).not.toHaveBeenCalled();
    expect(output()).toContain('1 username(s) skipped as unresolvable or ambiguous');
  });

  it('skips a username with no account at all', async () => {
    mockInviteFind.mockReturnValueOnce([{ _id: 'i1', username: 'ghost' }]);
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
    }));
    mockInviteFind.mockReturnValueOnce(fullBatch).mockReturnValueOnce([{ _id: 'i1000', username: 'alice' }]);
    mockUserFind.mockReturnValue([{ _id: 'u-alice', username: 'alice' }]);

    await migration.up();

    expect(mockInviteFind).toHaveBeenCalledTimes(2);
    expect(mockInviteFind.mock.calls[0][0]._id).toBeUndefined();
    expect(mockInviteFind.mock.calls[1][0]._id).toEqual({ $gt: 'i999' });
    // One User lookup, not one per batch: the resolution cache spans the scan.
    expect(mockUserFind).toHaveBeenCalledTimes(1);
    expect(output()).toContain('set inviterId on 1001 invite(s)');
  });

  it('reports nothing to do when no invite is missing inviterId', async () => {
    await migration.up();

    expect(mockInviteBulkWrite).not.toHaveBeenCalled();
    expect(output()).toContain('set inviterId on 0 invite(s)');
  });
});
