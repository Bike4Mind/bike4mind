import { describe, it, expect, vi, beforeEach } from 'vitest';

const findById = vi.fn();
const orgFind = vi.fn();
const orgSort = vi.fn();
const orgLimit = vi.fn();
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {
    findById: (...args: unknown[]) => findById(...args),
  },
  Organization: {
    find: (...args: unknown[]) => {
      orgFind(...args);
      const filter = args[0] as { name: { $regex: string } };
      const query = {
        select: () => query,
        sort: (...sortArgs: unknown[]) => {
          orgSort(...sortArgs);
          return query;
        },
        limit: (...limitArgs: unknown[]) => {
          orgLimit(...limitArgs);
          return query;
        },
        lean: () => (filter.name.$regex.startsWith('^') ? exactRows : partialRows),
      };
      return query;
    },
  },
}));

import { resolveAdminOrgRef } from './resolveAdminOrgRef';
import { AdminOrgRefSchema } from './schemas';

const ORG_ID = '65f1a2b3c4d5e6f708192a3b';

type Row = { _id: string; name: string; personal: boolean };
let exactRows: Row[] = [];
let partialRows: Row[] = [];

const org = (id: string, name: string) => ({ id, name, personal: false });
const rows = (count: number, prefix: string): Row[] =>
  Array.from({ length: count }, (_, index) => ({ _id: `o${index}`, name: `${prefix} ${index}`, personal: false }));

describe('resolveAdminOrgRef', () => {
  beforeEach(() => {
    findById.mockReset();
    orgFind.mockReset();
    orgSort.mockReset();
    orgLimit.mockReset();
    exactRows = [];
    partialRows = [];
  });

  it('finds an organization by id', async () => {
    findById.mockResolvedValue(org(ORG_ID, 'Acme'));

    await expect(resolveAdminOrgRef({ orgId: ORG_ID })).resolves.toEqual({ ok: true, org: org(ORG_ID, 'Acme') });
    expect(findById).toHaveBeenCalledWith(ORG_ID);
    expect(orgFind).not.toHaveBeenCalled();
  });

  it('returns not_found for an unknown id', async () => {
    findById.mockResolvedValue(null);

    await expect(resolveAdminOrgRef({ orgId: ORG_ID })).resolves.toMatchObject({ ok: false, error: 'not_found' });
  });

  it('matches the name exactly, case-insensitively, with regex metacharacters escaped', async () => {
    exactRows = [{ _id: ORG_ID, name: 'A.C (me)', personal: false }];
    findById.mockResolvedValue(org(ORG_ID, 'A.C (me)'));

    await expect(resolveAdminOrgRef({ name: 'a.c (ME)' })).resolves.toEqual({ ok: true, org: org(ORG_ID, 'A.C (me)') });
    expect(orgFind).toHaveBeenCalledWith({ name: { $regex: '^a\\.c \\(ME\\)$', $options: 'i' } });
    expect(findById).toHaveBeenCalledWith(ORG_ID);
  });

  it('resolves an exact match however many partial matches would sort ahead of it', async () => {
    exactRows = [{ _id: ORG_ID, name: 'demo', personal: false }];
    findById.mockResolvedValue(org(ORG_ID, 'demo'));
    partialRows = rows(11, 'ABC Demo');

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
    expect(orgLimit).toHaveBeenCalledWith(11);
  });

  it('returns ambiguous with the first 10 exact matches and says when the list was cut', async () => {
    exactRows = rows(11, 'Acme');

    const result = await resolveAdminOrgRef({ name: 'Acme' });

    expect(result).toMatchObject({ ok: false, error: 'ambiguous', message: expect.stringContaining('More than 10') });
    expect((result as { candidates: unknown[] }).candidates).toHaveLength(10);
  });

  it('resolves a single partial match when nothing matches exactly', async () => {
    partialRows = [{ _id: 'o2', name: 'Acme Labs', personal: false }];
    findById.mockResolvedValue(org('o2', 'Acme Labs'));

    await expect(resolveAdminOrgRef({ name: 'a.me' })).resolves.toMatchObject({ ok: true, org: { id: 'o2' } });
    expect(findById).toHaveBeenCalledWith('o2');
    expect(orgFind).toHaveBeenLastCalledWith({ name: { $regex: 'a\\.me', $options: 'i' } });
    expect(orgSort).toHaveBeenLastCalledWith({ name: 1 });
    expect(orgLimit).toHaveBeenLastCalledWith(11);
  });

  it('returns ambiguous with every partial candidate', async () => {
    partialRows = [
      { _id: 'o2', name: 'Acme Labs', personal: false },
      { _id: 'o3', name: 'Acme West', personal: false },
    ];

    await expect(resolveAdminOrgRef({ name: 'acme' })).resolves.toEqual({
      ok: false,
      error: 'ambiguous',
      message: expect.stringContaining('Several'),
      candidates: [
        { id: 'o2', name: 'Acme Labs', personal: false },
        { id: 'o3', name: 'Acme West', personal: false },
      ],
    });
  });

  it('says when the partial candidate list was cut', async () => {
    partialRows = rows(11, 'Acme');

    const result = await resolveAdminOrgRef({ name: 'acme' });

    expect(result).toMatchObject({ ok: false, error: 'ambiguous', message: expect.stringContaining('More than 10') });
    expect((result as { candidates: unknown[] }).candidates).toHaveLength(10);
  });

  it('returns not_found when no name matches', async () => {
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
