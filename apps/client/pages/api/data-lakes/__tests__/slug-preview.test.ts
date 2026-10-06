// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  captured: {} as { get?: (req: unknown, res: unknown) => Promise<unknown> },
  previewDataLakeSlug: vi.fn(),
  findAccessibleById: vi.fn(),
  findOrgById: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.captured.get = fn;
      return chain;
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/dataLakes/dataLakeScopes', () => ({ DATA_LAKE_READ_SCOPES: [] }));
// resolveActiveOrg runs for real, so the org gate is exercised rather than stubbed.
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { tag: 'repo' },
  organizationRepository: { shareable: { findAccessibleById: h.findAccessibleById }, findById: h.findOrgById },
}));
vi.mock('@bike4mind/services', () => ({ dataLakeService: { previewDataLakeSlug: h.previewDataLakeSlug } }));

import '../slug-preview';

const makeRes = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() });
const get = (
  query: Record<string, unknown>,
  apiKeyInfo?: { keyId: string },
  user: Record<string, unknown> = { id: 'u1' }
) => {
  const res = makeRes();
  const req = { user, apiKeyInfo, query };
  return { req, res, done: h.captured.get!(req, res) };
};

beforeEach(() => {
  h.previewDataLakeSlug.mockReset().mockResolvedValue('vendor-contracts-1');
  h.findAccessibleById
    .mockReset()
    .mockImplementation(async (_user: unknown, id: string) => (id === 'org-1' ? { id: 'org-1' } : null));
  h.findOrgById.mockReset().mockResolvedValue(null);
});

describe('GET /api/data-lakes/slug-preview', () => {
  it('refuses API-key callers', async () => {
    await expect(get({ name: 'Vendor Contracts' }, { keyId: 'k1' }).done).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.previewDataLakeSlug).not.toHaveBeenCalled();
  });

  it.each([{}, { name: '' }, { name: '  ' }, { name: ['a', 'b'] }, { name: '!!!' }])(
    '400s on a bad name %j',
    async query => {
      await expect(get(query).done).rejects.toBeInstanceOf(BadRequestError);
      expect(h.previewDataLakeSlug).not.toHaveBeenCalled();
    }
  );

  it('400s on a repeated organizationId', async () => {
    await expect(get({ name: 'x', organizationId: ['a', 'b'] }).done).rejects.toBeInstanceOf(BadRequestError);
  });

  it('403s on an org the caller cannot use, before computing any slug', async () => {
    await expect(get({ name: 'x-lake', organizationId: 'org-x' }).done).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.previewDataLakeSlug).not.toHaveBeenCalled();
  });

  it('resolves the org like create and returns only the slug', async () => {
    const { req, res, done } = get({ name: 'Vendor Contracts', organizationId: 'org-1' });
    await done;

    expect(h.findAccessibleById).toHaveBeenCalledWith(req.user, 'org-1');
    expect(h.previewDataLakeSlug).toHaveBeenCalledWith({ dataLakes: { tag: 'repo' } }, 'Vendor Contracts', 'org-1');
    expect(res.json).toHaveBeenCalledWith({ slug: 'vendor-contracts-1' });
  });

  it('previews in personal scope when no organizationId is sent', async () => {
    await get({ name: 'Vendor Contracts' }).done;

    expect(h.findAccessibleById).not.toHaveBeenCalled();
    expect(h.previewDataLakeSlug).toHaveBeenCalledWith({ dataLakes: { tag: 'repo' } }, 'Vendor Contracts', undefined);
  });

  it('404s an admin on an org that does not exist', async () => {
    await expect(
      get({ name: 'x-lake', organizationId: 'org-gone' }, undefined, { id: 'admin', isAdmin: true }).done
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(h.previewDataLakeSlug).not.toHaveBeenCalled();
  });
});
