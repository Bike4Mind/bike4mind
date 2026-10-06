// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError, ForbiddenError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  captured: {} as { get?: (req: unknown, res: unknown) => Promise<unknown> },
  previewDataLakeSlug: vi.fn(),
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
vi.mock('@bike4mind/services', () => ({ dataLakeService: { previewDataLakeSlug: h.previewDataLakeSlug } }));

import '../slug-preview';

const makeRes = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() });
const get = (query: Record<string, unknown>, apiKeyInfo?: { keyId: string }) => {
  const res = makeRes();
  const req = { user: { id: 'u1' }, apiKeyInfo, query };
  return { req, res, done: h.captured.get!(req, res) };
};

beforeEach(() => {
  h.previewDataLakeSlug.mockReset().mockResolvedValue('vendor-contracts-1');
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

  it('resolves the org like create and returns only the slug', async () => {
    const { req, res, done } = get({ name: 'Vendor Contracts', organizationId: 'org-1' });
    await done;

    expect(h.resolveActiveOrg).toHaveBeenCalledWith(req, 'org-1');
    expect(h.previewDataLakeSlug).toHaveBeenCalledWith({ dataLakes: { tag: 'repo' } }, 'Vendor Contracts', 'org-1');
    expect(res.json).toHaveBeenCalledWith({ slug: 'vendor-contracts-1' });
  });
});
