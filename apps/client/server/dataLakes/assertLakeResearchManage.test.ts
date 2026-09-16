import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  resolveCanManageLake: vi.fn(),
  toAccessContext: vi.fn(),
}));

vi.mock('@bike4mind/services', () => ({
  dataLakeService: { assertLakeAccess: h.assertLakeAccess, resolveCanManageLake: h.resolveCanManageLake },
}));
vi.mock('@bike4mind/database', () => ({ dataLakeRepository: {}, dataLakeAccessGrantRepository: {} }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import { assertLakeResearchManage } from './assertLakeResearchManage';

const req = { user: { id: 'u1' } } as never;
const lake = { id: 'lake-oid-1', name: 'Ops Lake' };

beforeEach(() => {
  vi.clearAllMocks();
  h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, administeredOrgIds: [] });
  h.assertLakeAccess.mockResolvedValue(lake);
  h.resolveCanManageLake.mockResolvedValue(true);
});

describe('assertLakeResearchManage', () => {
  it('returns the resolved lake for a manager, so callers scope by id rather than by slug', async () => {
    expect(await assertLakeResearchManage(req, 'my-lake')).toBe(lake);
    expect(h.assertLakeAccess).toHaveBeenCalledWith('my-lake', expect.anything(), expect.anything());
  });

  // Configuring what a run searches for, and spending money running it, are management rights.
  it('refuses a caller who can read the lake but not manage it', async () => {
    h.resolveCanManageLake.mockResolvedValue(false);

    await expect(assertLakeResearchManage(req, 'my-lake')).rejects.toThrow(/permission to manage research runs/i);
  });

  // Existence must never be probeable through a 403: the read gate answers not-found first.
  it('runs the read gate before the manage gate', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('Data lake not found'));

    await expect(assertLakeResearchManage(req, 'someone-elses-lake')).rejects.toThrow(/not found/i);
    expect(h.resolveCanManageLake).not.toHaveBeenCalled();
  });

  it('resolves manage against the RESOLVED lake, not the raw id-or-slug', async () => {
    await assertLakeResearchManage(req, 'my-lake');

    expect(h.resolveCanManageLake).toHaveBeenCalledWith(lake, expect.anything(), expect.anything());
  });
});
