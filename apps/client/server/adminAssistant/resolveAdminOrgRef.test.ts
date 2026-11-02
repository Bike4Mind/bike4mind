import { describe, it, expect, vi, beforeEach } from 'vitest';

const findById = vi.fn();
const search = vi.fn();
const exactFind = vi.fn();
const exactLimit = vi.fn();
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {
    findById: (...args: unknown[]) => findById(...args),
    search: (...args: unknown[]) => search(...args),
  },
  Organization: {
    find: (...args: unknown[]) => {
      exactFind(...args);
      const query = {
        select: () => query,
        limit: (...limitArgs: unknown[]) => {
          exactLimit(...limitArgs);
          return query;
        },
        lean: () => exactRows,
      };
      return query;
    },
  },
}));

import { resolveAdminOrgRef } from './resolveAdminOrgRef';
import { AdminOrgRefSchema } from './schemas';

const ORG_ID = '65f1a2b3c4d5e6f708192a3b';

let exactRows: { _id: string; name: string; personal: boolean }[] = [];

const org = (id: string, name: string) => ({ id, name, personal: false });
const searchReturns = (data: unknown[], hasMore = false) =>
  search.mockResolvedValue({ data, hasMore, total: data.length });

describe('resolveAdminOrgRef', () => {
  beforeEach(() => {
    findById.mockReset();
    search.mockReset();
    exactFind.mockReset();
    exactLimit.mockReset();
    exactRows = [];
  });

  it('finds an organization by id', async () => {
    findById.mockResolvedValue(org(ORG_ID, 'Acme'));

    await expect(resolveAdminOrgRef({ orgId: ORG_ID })).resolves.toEqual({ ok: true, org: org(ORG_ID, 'Acme') });
    expect(findById).toHaveBeenCalledWith(ORG_ID);
    expect(exactFind).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('returns not_found for an unknown id', async () => {
    findById.mockResolvedValue(null);

    await expect(resolveAdminOrgRef({ orgId: ORG_ID })).resolves.toMatchObject({ ok: false, error: 'not_found' });
  });

  it('matches the name exactly, case-insensitively, with regex metacharacters escaped', async () => {
    exactRows = [{ _id: ORG_ID, name: 'A.C (me)', personal: false }];
    findById.mockResolvedValue(org(ORG_ID, 'A.C (me)'));

    await expect(resolveAdminOrgRef({ name: 'a.c (ME)' })).resolves.toEqual({ ok: true, org: org(ORG_ID, 'A.C (me)') });
    expect(exactFind).toHaveBeenCalledWith({ name: { $regex: '^a\\.c \\(ME\\)$', $options: 'i' } });
    expect(findById).toHaveBeenCalledWith(ORG_ID);
    expect(search).not.toHaveBeenCalled();
  });

  it('resolves an exact match however many partial matches would sort ahead of it', async () => {
    exactRows = [{ _id: ORG_ID, name: 'demo', personal: false }];
    findById.mockResolvedValue(org(ORG_ID, 'demo'));
    searchReturns(
      Array.from({ length: 10 }, (_, index) => org(`o${index}`, `ABC Demo ${index}`)),
      true
    );

    await expect(resolveAdminOrgRef({ name: 'demo' })).resolves.toMatchObject({ ok: true, org: { id: ORG_ID } });
  });

  it('returns ambiguous with only the exact matches when several share the name', async () => {
    exactRows = [
      { _id: 'o1', name: 'Acme', personal: false },
      { _id: 'o4', name: 'acme', personal: true },
    ];

    await expect(resolveAdminOrgRef({ name: 'Acme' })).resolves.toEqual({
      ok: false,
      error: 'ambiguous',
      message: expect.stringContaining('Several'),
      candidates: [
        { id: 'o1', name: 'Acme', personal: false },
        { id: 'o4', name: 'acme', personal: true },
      ],
    });
    expect(exactLimit).toHaveBeenCalledWith(11);
    expect(search).not.toHaveBeenCalled();
  });

  it('resolves a single partial match when nothing matches exactly', async () => {
    searchReturns([org('o2', 'Acme Labs')]);

    await expect(resolveAdminOrgRef({ name: 'acme' })).resolves.toMatchObject({ ok: true, org: { id: 'o2' } });
    expect(search).toHaveBeenCalledWith(
      '',
      { name: 'acme' },
      { page: 1, limit: 10 },
      { field: 'name', direction: 'asc' }
    );
  });

  it('returns ambiguous with every partial candidate and says when the list was cut', async () => {
    searchReturns([org('o2', 'Acme Labs'), org('o3', 'Acme West')], true);

    await expect(resolveAdminOrgRef({ name: 'acme' })).resolves.toEqual({
      ok: false,
      error: 'ambiguous',
      message: expect.stringContaining('More than 10'),
      candidates: [
        { id: 'o2', name: 'Acme Labs', personal: false },
        { id: 'o3', name: 'Acme West', personal: false },
      ],
    });
  });

  it('returns not_found when no name matches', async () => {
    searchReturns([]);

    await expect(resolveAdminOrgRef({ name: 'nothing' })).resolves.toMatchObject({ ok: false, error: 'not_found' });
  });
});

describe('AdminOrgRefSchema', () => {
  it('requires exactly one of orgId or name', () => {
    expect(AdminOrgRefSchema.safeParse({}).success).toBe(false);
    expect(AdminOrgRefSchema.safeParse({ orgId: ORG_ID, name: 'Acme' }).success).toBe(false);
    expect(AdminOrgRefSchema.safeParse({ orgId: ORG_ID }).success).toBe(true);
    expect(AdminOrgRefSchema.safeParse({ name: 'Acme' }).success).toBe(true);
  });

  it('rejects a malformed id and a blank name', () => {
    expect(AdminOrgRefSchema.safeParse({ orgId: 'not-an-id' }).success).toBe(false);
    expect(AdminOrgRefSchema.safeParse({ name: '   ' }).success).toBe(false);
  });
});
