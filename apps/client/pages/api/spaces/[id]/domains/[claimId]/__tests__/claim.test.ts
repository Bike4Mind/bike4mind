import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@bike4mind/common';

const refs = vi.hoisted(() => ({
  handlers: {} as Record<string, Record<string, (req: unknown, res: unknown) => unknown>>,
  uses: {} as Record<string, unknown[]>,
  current: '',
}));
vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {
    use: (fn: unknown) => {
      (refs.uses[refs.current] ??= []).push(fn);
      return chain;
    },
  };
  for (const method of ['post', 'patch', 'delete']) {
    chain[method] = (...fns: unknown[]) => {
      (refs.handlers[refs.current] ??= {})[method] = fns[fns.length - 1] as (req: unknown, res: unknown) => unknown;
      return chain;
    };
  }
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({
  requireFeatureEnabled: (name: string) => ({ flag: name }),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => ({ rateLimit: options }),
}));

const mocks = vi.hoisted(() => ({
  loadManagedSpace: vi.fn(),
  findByIdForSpace: vi.fn(),
  deleteForSpace: vi.fn(),
  updateSpaceDomainClaimPolicy: vi.fn(),
  verifySpaceDomainClaim: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  orgDomainClaimRepository: { findByIdForSpace: mocks.findByIdForSpace, deleteForSpace: mocks.deleteForSpace },
}));
vi.mock('@server/spaces/spaceAccess', () => ({ loadManagedSpace: mocks.loadManagedSpace }));
vi.mock('@server/organizations/orgDomainClaims', () => ({
  updateSpaceDomainClaimPolicy: mocks.updateSpaceDomainClaimPolicy,
  verifySpaceDomainClaim: mocks.verifySpaceDomainClaim,
  toOrgDomainClaimView: (claim: { id: string; policy?: string }) => ({ id: claim.id, policy: claim.policy }),
}));

refs.current = 'claim';
await import('@pages/api/spaces/[id]/domains/[claimId]/index');
refs.current = 'verify';
await import('@pages/api/spaces/[id]/domains/[claimId]/verify');

const SPACE_ID = '65a1f77bcf86cd7994390010';
const CLAIM_ID = '65a1f77bcf86cd7994390020';

const call = async (
  route: 'claim' | 'verify',
  method: 'post' | 'patch' | 'delete',
  body?: unknown,
  claimId = CLAIM_ID
) => {
  const { req, res } = createMocks({
    method: method.toUpperCase() as 'POST',
    query: { id: SPACE_ID, claimId },
    body,
  });
  const request = req as unknown as { user: unknown; logger: unknown };
  request.user = { id: 'u-owner' };
  request.logger = { info: vi.fn() };
  await refs.handlers[route][method](req, res);
  return res;
};

describe('/api/spaces/[id]/domains/[claimId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadManagedSpace.mockResolvedValue({ id: SPACE_ID });
  });

  it('sits behind the EnableSpaces flag on both routes, and rate-limits verify', () => {
    expect(refs.uses.claim).toContainEqual({ flag: 'EnableSpaces' });
    expect(refs.uses.verify).toContainEqual({ flag: 'EnableSpaces' });
    expect(refs.uses.verify).toContainEqual({
      rateLimit: expect.objectContaining({ limit: 10, windowMs: 60000, bucket: 'spaces/domains/verify' }),
    });
  });

  it('patches the policy within the managed Space', async () => {
    mocks.updateSpaceDomainClaimPolicy.mockResolvedValue({
      before: { id: CLAIM_ID, domain: 'acme.com', policy: 'off' },
      after: { id: CLAIM_ID, domain: 'acme.com', policy: 'suggest' },
    });
    const res = await call('claim', 'patch', { policy: 'suggest' });
    expect(mocks.updateSpaceDomainClaimPolicy).toHaveBeenCalledWith(SPACE_ID, CLAIM_ID, { policy: 'suggest' });
    expect(res._getJSONData()).toEqual({ claim: { id: CLAIM_ID, policy: 'suggest' } });
  });

  it('refuses an org-only policy value', async () => {
    await expect(call('claim', 'patch', { policy: 'auto-join' })).rejects.toBeTruthy();
    expect(mocks.updateSpaceDomainClaimPolicy).not.toHaveBeenCalled();
  });

  it('deletes a claim of this Space with 204', async () => {
    mocks.findByIdForSpace.mockResolvedValue({ id: CLAIM_ID, domain: 'acme.com' });
    mocks.deleteForSpace.mockResolvedValue(true);
    const res = await call('claim', 'delete');
    expect(mocks.deleteForSpace).toHaveBeenCalledWith(CLAIM_ID, SPACE_ID);
    expect(res.statusCode).toBe(204);
  });

  it('404s a claim outside the Space and a malformed id', async () => {
    mocks.findByIdForSpace.mockResolvedValue(null);
    await expect(call('claim', 'delete')).rejects.toBeInstanceOf(NotFoundError);
    await expect(call('claim', 'delete', undefined, 'not-an-id')).rejects.toBeInstanceOf(NotFoundError);
    await expect(call('verify', 'post', undefined, 'not-an-id')).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.deleteForSpace).not.toHaveBeenCalled();
  });

  it('answers a DNS miss with 200 verified:false and a hit with the claim', async () => {
    mocks.verifySpaceDomainClaim.mockResolvedValueOnce({ verified: false, reason: 'no record' });
    expect((await call('verify', 'post'))._getJSONData()).toEqual({ verified: false, reason: 'no record' });
    mocks.verifySpaceDomainClaim.mockResolvedValueOnce({ verified: true, claim: { id: CLAIM_ID, domain: 'acme.com' } });
    expect((await call('verify', 'post'))._getJSONData()).toMatchObject({ verified: true });
    expect(mocks.verifySpaceDomainClaim).toHaveBeenCalledWith(SPACE_ID, CLAIM_ID);
  });

  it('gives a non-manager the Space not-found', async () => {
    mocks.loadManagedSpace.mockRejectedValue(new NotFoundError('Space not found'));
    await expect(call('claim', 'patch', { policy: 'off' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(call('verify', 'post')).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.verifySpaceDomainClaim).not.toHaveBeenCalled();
  });
});
