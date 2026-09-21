import { describe, it, expect, vi, beforeEach } from 'vitest';

type Filter = Record<string, unknown>;
type InviteRow = {
  _id: string;
  isLinkOnly?: boolean;
  type?: string;
  recipients?: { pending?: string[]; accepted?: string[]; refused?: string[] };
};

const mockFind = vi.fn<(filter: Filter) => InviteRow[]>();
const mockBulkWrite = vi.fn<(writes: unknown[]) => Promise<{ modifiedCount: number }>>();

vi.mock('@bike4mind/database', () => ({
  Invite: {
    // Mirrors the real chain: find().sort().limit().select() resolves to the rows.
    find: (filter: Filter) => {
      const rows = mockFind(filter);
      const chain = { sort: () => chain, limit: () => chain, select: () => Promise.resolve(rows) };
      return chain;
    },
    bulkWrite: (writes: unknown[]) => mockBulkWrite(writes),
  },
}));

import migration from './20260917000000_cap-legacy-invite-link-expiry';

let logged: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  mockFind.mockReturnValue([]);
  mockBulkWrite.mockImplementation(async writes => ({ modifiedCount: writes.length }));
});

const cappedIds = () =>
  mockBulkWrite.mock.calls.flatMap(([writes]) =>
    (writes as Array<{ updateOne: { filter: { _id: string } } }>).map(w => w.updateOne.filter._id)
  );

const linkInvite = (id: string): InviteRow => ({ _id: id, isLinkOnly: true, type: 'FabFile' });
const namedInvite = (id: string): InviteRow => ({
  _id: id,
  isLinkOnly: false,
  type: 'FabFile',
  recipients: { pending: ['someone@x.com'], accepted: [], refused: [] },
});

describe('cap-legacy-invite-link-expiry', () => {
  it('queries only tokenless invites with an unbounded or far-future expiry', async () => {
    await migration.up();

    const filter = mockFind.mock.calls[0][0];
    expect(filter.token).toEqual({ $exists: false });
    expect(filter.$or).toEqual([
      { expiresAt: { $exists: false } },
      { expiresAt: null },
      { expiresAt: { $gt: expect.any(Date) } },
    ]);
  });

  it('caps a tokenless LINK invite', async () => {
    mockFind.mockReturnValueOnce([linkInvite('i1')]);

    await migration.up();

    expect(cappedIds()).toEqual(['i1']);
  });

  // The finding. A named invite is addressed by `_id` from the inbox and re-checks the caller's
  // identity at every door, so its id was never the secret the token replaced - capping it would
  // expire a working share early and close no hole.
  it('leaves a tokenless NAMED invite alone, and says so', async () => {
    mockFind.mockReturnValueOnce([namedInvite('i2')]);

    await migration.up();

    expect(mockBulkWrite).not.toHaveBeenCalled();
    expect(logged.join('\n')).toContain('left 1 named invite(s) alone');
  });

  it('splits a mixed batch rather than skipping it', async () => {
    mockFind.mockReturnValueOnce([linkInvite('i1'), namedInvite('i2'), linkInvite('i3')]);

    await migration.up();

    expect(cappedIds()).toEqual(['i1', 'i3']);
  });

  // Rows minted before the flag existed carry no `isLinkOnly`; the inference reads them as link-only
  // when nobody is named AND the type is one whose recipients always resolved to emails.
  it('infers link-only for a pre-flag FabFile row naming nobody', async () => {
    mockFind.mockReturnValueOnce([
      { _id: 'i1', type: 'FabFile', recipients: { pending: [], accepted: [], refused: [] } },
      { _id: 'i2', type: 'Project', recipients: { pending: [], accepted: [], refused: [] } },
    ]);

    await migration.up();

    // The Project row fails closed: a legacy Project invite carried raw user ids that may simply
    // have failed to resolve, so an empty recipient list does not prove it names nobody.
    expect(cappedIds()).toEqual(['i1']);
  });

  it('keeps walking past a full page of named invites instead of stalling', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => namedInvite(`n${i}`));
    mockFind.mockReturnValueOnce(page).mockReturnValueOnce([linkInvite('i1')]);

    await migration.up();

    expect(mockFind.mock.calls[1][0]._id).toEqual({ $gt: 'n999' });
    expect(cappedIds()).toEqual(['i1']);
  });
});
