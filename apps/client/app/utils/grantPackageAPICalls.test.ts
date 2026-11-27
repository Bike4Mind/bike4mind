import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api }));

import {
  createGrantPackage,
  fetchGrantPackageLinks,
  fetchGrantPackages,
  grantPackageLinksQueryKey,
  updateGrantPackage,
} from './grantPackageAPICalls';

describe('grantPackageAPICalls', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue({ data: 'body' });
  });

  it('lists packages, asking for usage only when requested', async () => {
    expect(await fetchGrantPackages({ page: 2 })).toBe('body');
    expect(api.get).toHaveBeenLastCalledWith('/api/admin/grant-packages', { params: { page: 2 } });
    await fetchGrantPackages({ page: 1, usage: true });
    expect(api.get).toHaveBeenLastCalledWith('/api/admin/grant-packages', { params: { page: 1, usage: '1' } });
  });

  it('creates and updates a package', async () => {
    const body = { name: 'Launch', credits: 100 } as Parameters<typeof createGrantPackage>[0];
    expect(await createGrantPackage(body)).toBe('body');
    expect(api.post).toHaveBeenCalledWith('/api/admin/grant-packages', body);
    expect(await updateGrantPackage('p1', { active: false })).toBe('body');
    expect(api.patch).toHaveBeenCalledWith('/api/admin/grant-packages/p1', { active: false });
  });

  it('fetches the codes and partner rules linked to a package', async () => {
    expect(await fetchGrantPackageLinks('p1')).toBe('body');
    expect(api.get).toHaveBeenCalledWith('/api/admin/grant-packages/p1/links');
    expect(grantPackageLinksQueryKey('p1')).toEqual(['admin-grant-packages', 'p1', 'links']);
  });
});
