// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError, ForbiddenError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  captured: {} as { get?: (req: unknown, res: unknown) => Promise<unknown> },
  previewDataLakeSlug: vi.fn(),
  previewDataLakeTagPrefix: vi.fn(),
  resolveActiveOrg: vi.fn(),
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
vi.mock('@server/utils/resolveActiveOrg', () => ({ resolveActiveOrg: h.resolveActiveOrg }));
vi.mock('@bike4mind/database', () => ({ dataLakeRepository: { tag: 'repo' } }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { previewDataLakeSlug: h.previewDataLakeSlug, previewDataLakeTagPrefix: h.previewDataLakeTagPrefix },
}));

import '../slug-preview';

const makeRes = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() });
const get = (query: Record<string, unknown>, apiKeyInfo?: { keyId: string }) => {
  const res = makeRes();
  const req = { user: { id: 'u1' }, apiKeyInfo, query };
  return { req, res, done: h.captured.get!(req, res) };
};

beforeEach(() => {
  h.previewDataLakeSlug.mockReset().mockResolvedValue('vendor-contracts-1');
  h.previewDataLakeTagPrefix.mockReset().mockImplementation(async (_db, base: string) => base.replace(/:$/, '-1:'));
  h.resolveActiveOrg.mockReset().mockResolvedValue('org-1');
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
    h.resolveActiveOrg.mockRejectedValue(new ForbiddenError('You are not a member of the selected organization.'));

    await expect(get({ name: 'x-lake', organizationId: 'org-x' }).done).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.previewDataLakeSlug).not.toHaveBeenCalled();
  });

  it('400s on a repeated tagPrefix', async () => {
    await expect(get({ name: 'x-lake', tagPrefix: ['a:', 'b:'] }).done).rejects.toBeInstanceOf(BadRequestError);
  });

  it("resolves the org like create and previews the name-derived prefix in the caller's scope", async () => {
    const { req, res, done } = get({ name: 'Vendor Contracts', organizationId: 'org-1' });
    await done;

    expect(h.resolveActiveOrg).toHaveBeenCalledWith(req, 'org-1');
    expect(h.previewDataLakeSlug).toHaveBeenCalledWith({ dataLakes: { tag: 'repo' } }, 'Vendor Contracts', 'org-1');
    expect(h.previewDataLakeTagPrefix).toHaveBeenCalledWith({ dataLakes: { tag: 'repo' } }, 'vendor-contracts:', {
      createdByUserId: 'u1',
      organizationId: 'org-1',
    });
    expect(res.json).toHaveBeenCalledWith({ slug: 'vendor-contracts-1', tagPrefix: 'vendor-contracts-1:' });
  });

  it('judges a typed prefix in its submitted form', async () => {
    const { res, done } = get({ name: 'Vendor Contracts', tagPrefix: ' legal ' });
    await done;

    expect(h.previewDataLakeTagPrefix.mock.calls[0][1]).toBe('legal:');
    expect(res.json).toHaveBeenCalledWith({ slug: 'vendor-contracts-1', tagPrefix: 'legal-1:' });
  });

  it.each([
    ['empty', { name: 'Vendor Contracts', tagPrefix: '' }],
    ['reserved', { name: 'Vendor Contracts', tagPrefix: 'datalake:' }],
    ['blank-segment', { name: 'Vendor Contracts', tagPrefix: 'a::' }],
    ['over-long', { name: 'Vendor Contracts', tagPrefix: 'x'.repeat(200) }],
    ['reserved name-derived', { name: 'Datalake' }],
  ])('returns tagPrefix null for an unusable %s base, slug still previewed', async (_label, query) => {
    const { res, done } = get(query);
    await done;

    expect(h.previewDataLakeTagPrefix).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ slug: 'vendor-contracts-1', tagPrefix: null });
  });
});
