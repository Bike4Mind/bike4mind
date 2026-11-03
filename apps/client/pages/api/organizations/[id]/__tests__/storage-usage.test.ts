// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, NotFoundError } from '@bike4mind/common';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | Handler,
  baseApiOptions: undefined as unknown,
  rateLimitOptions: undefined as unknown,
  orgFindById: vi.fn(),
  getOrganizationStorageUsage: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: { use: () => unknown; get: (fn: Handler) => unknown } = {
    use: () => chain,
    get: (fn: Handler) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return {
    baseApi: (options: unknown) => {
      mockRefs.baseApiOptions = options;
      return chain;
    },
  };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    mockRefs.rateLimitOptions = options;
    return vi.fn();
  },
}));

// The gate (verifyOrgAdminRead) runs for real against a stubbed repository, so these tests pin who
// the route admits rather than asserting a mocked helper.
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: (...args: unknown[]) => mockRefs.orgFindById(...args) },
}));
// orgAccess pulls in resolveActiveOrg, which imports the NON-/infra barrel.
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {},
  fabFileRepository: { name: 'fabFiles' },
  userRepository: { name: 'users' },
}));
vi.mock('@bike4mind/services', () => ({
  organizationService: { getOrganizationStorageUsage: mockRefs.getOrganizationStorageUsage },
}));

import { ORG_STORAGE_USAGE_MAX_TIME_MS, ORG_STORAGE_USAGE_RATE_LIMIT } from '../storage-usage';

const ORG = '650000000000000000000abc';
const OWNER = '650000000000000000000111';
const APPOINTED_ADMIN = '650000000000000000000444';
const MEMBER = '650000000000000000000333';

const org = {
  id: ORG,
  userId: OWNER,
  adminUserIds: [APPOINTED_ADMIN],
  users: [{ userId: MEMBER }],
  storageLimit: 5,
  currentStorageSize: 400,
};
const usage = {
  organizationId: ORG,
  usedBytes: 400,
  limitBytes: 5_000_000,
  uploaders: [{ userId: MEMBER, bytes: 400, fileCount: 1, name: 'Member', email: 'm@example.com' }],
  uploadersTruncated: false,
};

const call = async (user: { id: string; isAdmin: boolean }, orgId: string = ORG) => {
  const { req, res } = createMocks({ method: 'GET', query: { id: orgId } });
  Object.assign(req, { user });
  await mockRefs.getHandler!(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRefs.orgFindById.mockResolvedValue(org);
  mockRefs.getOrganizationStorageUsage.mockResolvedValue(usage);
});

describe('GET /api/organizations/[id]/storage-usage', () => {
  it('is session-only and rate limited', () => {
    expect(mockRefs.baseApiOptions).toEqual({ auth: 'jwtOnly' });
    expect(mockRefs.rateLimitOptions).toMatchObject({
      bucket: 'org-storage-usage',
      limit: ORG_STORAGE_USAGE_RATE_LIMIT,
      windowMs: 60 * 1000,
    });
  });

  it.each([
    ['the owner', { id: OWNER, isAdmin: false }],
    ['an appointed admin', { id: APPOINTED_ADMIN, isAdmin: false }],
    ['a platform admin', { id: MEMBER, isAdmin: true }],
  ])('returns the usage to %s', async (_label, user) => {
    const res = await call(user);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(usage);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(mockRefs.getOrganizationStorageUsage).toHaveBeenCalledWith(
      org,
      { db: { fabFiles: { name: 'fabFiles' }, users: { name: 'users' } } },
      { maxTimeMS: ORG_STORAGE_USAGE_MAX_TIME_MS }
    );
  });

  it('404s an ordinary member without reading usage', async () => {
    await expect(call({ id: MEMBER, isAdmin: false })).rejects.toMatchObject({
      constructor: NotFoundError,
      message: 'Organization not found',
    });
    expect(mockRefs.getOrganizationStorageUsage).not.toHaveBeenCalled();
  });

  it('404s a missing org identically to a non-admin', async () => {
    mockRefs.orgFindById.mockResolvedValue(null);

    await expect(call({ id: OWNER, isAdmin: false })).rejects.toMatchObject({
      constructor: NotFoundError,
      message: 'Organization not found',
    });
    expect(mockRefs.getOrganizationStorageUsage).not.toHaveBeenCalled();
  });

  it('400s a malformed org id without touching the database', async () => {
    await expect(call({ id: OWNER, isAdmin: false }, 'not-an-object-id')).rejects.toMatchObject({
      constructor: BadRequestError,
    });
    expect(mockRefs.orgFindById).not.toHaveBeenCalled();
  });

  it('propagates a service failure without a 200 body or cache header', async () => {
    mockRefs.getOrganizationStorageUsage.mockRejectedValue(new Error('operation exceeded time limit'));
    const { req, res } = createMocks({ method: 'GET', query: { id: ORG } });
    Object.assign(req, { user: { id: OWNER, isAdmin: false } });

    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow('operation exceeded time limit');
    expect(res._isEndCalled()).toBe(false);
    expect(res.getHeader('Cache-Control')).toBeUndefined();
  });
});
