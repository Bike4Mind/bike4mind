import { describe, it, expect, vi, beforeEach } from 'vitest';

const findById = vi.fn();
const search = vi.fn();
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {
    findById: (...args: unknown[]) => findById(...args),
    search: (...args: unknown[]) => search(...args),
  },
}));

import { resolveAdminOrgRef } from './resolveAdminOrgRef';
import { AdminOrgRefSchema } from './schemas';

const ORG_ID = '65f1a2b3c4d5e6f708192a3b';

const org = (id: string, name: string) => ({ id, name, personal: false });
const searchReturns = (data: unknown[], hasMore = false) =>
  search.mockResolvedValue({ data, hasMore, total: data.length });

describe('resolveAdminOrgRef', () => {
  beforeEach(() => {
    findById.mockReset();
    search.mockReset();
  });

  it('finds an organization by id', async () => {
    findById.mockResolvedValue(org(ORG_ID, 'Acme'));

    await expect(resolveAdminOrgRef({ orgId: ORG_ID })).resolves.toEqual({ ok: true, org: org(ORG_ID, 'Acme') });
    expect(search).not.toHaveBeenCalled();
  });

  it('returns not_found for an unknown id', async () => {
    findById.mockResolvedValue(null);

    await expect(resolveAdminOrgRef({ orgId: ORG_ID })).resolves.toMatchObject({ ok: false, error: 'not_found' });
  });

  it('prefers the single case-insensitive exact match over partial matches', async () => {
    searchReturns([org('o1', 'Acme'), org('o2', 'Acme Labs')]);

    await expect(resolveAdminOrgRef({ name: 'ACME' })).resolves.toEqual({ ok: true, org: org('o1', 'Acme') });
    expect(search).toHaveBeenCalledWith('', { name: 'ACME' }, { page: 1, limit: 10 }, expect.anything());
  });

  it('resolves a single partial match', async () => {
    searchReturns([org('o2', 'Acme Labs')]);

    await expect(resolveAdminOrgRef({ name: 'acme' })).resolves.toMatchObject({ ok: true, org: { id: 'o2' } });
  });

  it('returns ambiguous with every candidate when several partial matches and no exact one', async () => {
    searchReturns([org('o2', 'Acme Labs'), org('o3', 'Acme West')]);

    await expect(resolveAdminOrgRef({ name: 'acme' })).resolves.toEqual({
      ok: false,
      error: 'ambiguous',
      message: expect.any(String),
      candidates: [
        { id: 'o2', name: 'Acme Labs', personal: false },
        { id: 'o3', name: 'Acme West', personal: false },
      ],
    });
  });

  it('narrows the candidates to the exact matches when several share the name', async () => {
    searchReturns([org('o1', 'Acme'), org('o4', 'acme'), org('o2', 'Acme Labs')]);

    const result = await resolveAdminOrgRef({ name: 'Acme' });

    expect(result).toMatchObject({ ok: false, error: 'ambiguous' });
    expect(result.ok === false && result.candidates?.map(candidate => (candidate as { id: string }).id)).toEqual([
      'o1',
      'o4',
    ]);
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
