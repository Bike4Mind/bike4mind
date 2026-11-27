import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@bike4mind/common';

const refs = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => unknown>,
  uses: [] as unknown[],
}));
vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {
    use: (fn: unknown) => {
      refs.uses.push(fn);
      return chain;
    },
  };
  for (const method of ['get', 'post']) {
    chain[method] = (...fns: unknown[]) => {
      refs.handlers[method] = fns[fns.length - 1] as (req: unknown, res: unknown) => unknown;
      return chain;
    };
  }
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({
  requireFeatureEnabled: (name: string) => ({ flag: name }),
}));

const mocks = vi.hoisted(() => ({ loadManagedSpace: vi.fn(), listBySpace: vi.fn(), addSpaceDomainClaim: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ orgDomainClaimRepository: { listBySpace: mocks.listBySpace } }));
vi.mock('@server/spaces/spaceAccess', () => ({ loadManagedSpace: mocks.loadManagedSpace }));
vi.mock('@server/organizations/orgDomainClaims', () => ({
  addSpaceDomainClaim: mocks.addSpaceDomainClaim,
  toOrgDomainClaimView: (claim: { id: string; domain: string }) => ({ id: claim.id, domain: claim.domain }),
}));

import '@pages/api/spaces/[id]/domains/index';

const SPACE_ID = '65a1f77bcf86cd7994390010';

const call = async (method: 'get' | 'post', body?: unknown) => {
  const { req, res } = createMocks({ method: method.toUpperCase() as 'GET', query: { id: SPACE_ID }, body });
  const request = req as unknown as { user: unknown; logger: unknown };
  request.user = { id: 'u-owner' };
  request.logger = { info: vi.fn() };
  await refs.handlers[method](req, res);
  return res;
};

describe('/api/spaces/[id]/domains', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadManagedSpace.mockResolvedValue({ id: SPACE_ID });
  });

  it('sits behind the EnableSpaces flag', () => {
    expect(refs.uses).toContainEqual({ flag: 'EnableSpaces' });
  });

  it('lists the claims of the managed Space with no-store', async () => {
    mocks.listBySpace.mockResolvedValue([{ id: 'c1', domain: 'acme.com' }]);
    const res = await call('get');
    expect(mocks.listBySpace).toHaveBeenCalledWith(SPACE_ID);
    expect(res._getJSONData()).toEqual({ claims: [{ id: 'c1', domain: 'acme.com' }] });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('adds a claim and answers 201', async () => {
    mocks.addSpaceDomainClaim.mockResolvedValue({ id: 'c1', domain: 'acme.com' });
    const res = await call('post', { domain: 'acme.com' });
    expect(mocks.addSpaceDomainClaim).toHaveBeenCalledWith(SPACE_ID, 'u-owner', 'acme.com');
    expect(res.statusCode).toBe(201);
  });

  it('rejects a body without a domain before claiming', async () => {
    await expect(call('post', {})).rejects.toBeTruthy();
    expect(mocks.addSpaceDomainClaim).not.toHaveBeenCalled();
  });

  it('gives a non-manager the Space not-found and touches nothing', async () => {
    mocks.loadManagedSpace.mockRejectedValue(new NotFoundError('Space not found'));
    await expect(call('get')).rejects.toBeInstanceOf(NotFoundError);
    await expect(call('post', { domain: 'acme.com' })).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.listBySpace).not.toHaveBeenCalled();
    expect(mocks.addSpaceDomainClaim).not.toHaveBeenCalled();
  });
});
