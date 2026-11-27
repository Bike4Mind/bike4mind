// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@bike4mind/common';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  // Each route module registers its GET in import order: index, options, members.
  getHandlers: [] as Handler[],
  verifyOrgPermission: vi.fn(),
  recordOrganizationRead: vi.fn(async () => undefined),
  findServiceAccount: vi.fn(async () => null),
  orgApiKeyOptions: vi.fn(async () => ({ scopes: [], groups: [] })),
  listOrgMemberKeys: vi.fn(async () => []),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    get: (fn: Handler) => {
      mocks.getHandlers.push(fn);
      return chain;
    },
    post: () => chain,
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Handler) => fn }));
vi.mock('@bike4mind/server-utils/utils/orgAccess', () => ({ verifyOrgPermission: mocks.verifyOrgPermission }));
vi.mock('@server/utils/orgReadAudit', () => ({ recordOrganizationRead: mocks.recordOrganizationRead }));
vi.mock('@server/organizations/orgApiKeys', () => ({
  assertOrgApiKeyScopesOffered: vi.fn(),
  creatorDisplayName: vi.fn(),
  findServiceAccount: mocks.findServiceAccount,
  getOrCreateServiceAccount: vi.fn(),
  normalizeOrgApiKeyGrants: vi.fn(),
  orgApiKeyOptions: mocks.orgApiKeyOptions,
  resolveCreatorNames: vi.fn(),
  toOrgApiKeyView: vi.fn(),
}));
vi.mock('@server/organizations/orgMemberApiKeys', () => ({
  listOrgMemberKeys: mocks.listOrgMemberKeys,
  resolveHolderNames: vi.fn(async () => new Map()),
  toOrgMemberApiKeyView: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ agentRepository: {}, organizationRepository: {}, withTransaction: vi.fn() }));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/services', () => ({ userApiKeyService: {} }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/apiKeyAccessGate', () => ({ assertApiKeyAccessAllowed: vi.fn() }));

import '@pages/api/organizations/[id]/api-keys/index';
import '@pages/api/organizations/[id]/api-keys/options';
import '@pages/api/organizations/[id]/api-keys/members/index';

const ORG = { id: '650000000000000000000abc', name: 'Acme' };

const routes: Array<[route: string, view: string, read: () => ReturnType<typeof vi.fn>]> = [
  ['GET /api/organizations/:id/api-keys', 'api_keys', () => mocks.findServiceAccount],
  ['GET /api/organizations/:id/api-keys/options', 'api_key_options', () => mocks.orgApiKeyOptions],
  ['GET /api/organizations/:id/api-keys/members', 'member_api_keys', () => mocks.listOrgMemberKeys],
];

const call = async (index: number) => {
  const { req, res } = createMocks({ method: 'GET', query: { id: ORG.id } });
  Object.assign(req, { user: { id: 'staff1', isAdmin: true } });
  await mocks.getHandlers[index](req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyOrgPermission.mockResolvedValue(ORG);
});

describe.each(routes.map((route, index) => [...route, index] as const))('%s', (_route, view, read, index) => {
  it('records the read against the organization before serving it', async () => {
    const { req, res } = await call(index);
    expect(mocks.verifyOrgPermission).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'staff1' }),
      ORG.id,
      'manageKeys'
    );
    expect(mocks.recordOrganizationRead).toHaveBeenCalledWith(req, [ORG], { view });
    expect(res._getStatusCode()).toBe(200);
  });

  it('serves nothing when the read cannot be recorded', async () => {
    mocks.recordOrganizationRead.mockRejectedValueOnce(new Error('audit down'));
    await expect(call(index)).rejects.toThrow('audit down');
    expect(read()).not.toHaveBeenCalled();
  });

  it('records nothing when the caller is refused the organization', async () => {
    mocks.verifyOrgPermission.mockRejectedValueOnce(new NotFoundError('Organization not found'));
    await expect(call(index)).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.recordOrganizationRead).not.toHaveBeenCalled();
    expect(read()).not.toHaveBeenCalled();
  });
});
