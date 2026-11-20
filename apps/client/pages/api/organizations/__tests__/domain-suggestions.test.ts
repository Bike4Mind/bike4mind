import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const mockRefs = vi.hoisted(() => ({ current: {} as Record<string, Handler>, configs: [] as unknown[] }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
    chain[method] = (fn: Handler) => {
      mockRefs.current[method] = fn;
      return chain;
    };
  }
  chain.use = () => chain;
  return {
    baseApi: (options: unknown) => {
      mockRefs.configs.push(options);
      return chain;
    },
  };
});

const claims = vi.hoisted(() => ({ findVerifiedJoinableByDomain: vi.fn() }));
const orgs = vi.hoisted(() => ({ findById: vi.fn() }));
const users = vi.hoisted(() => ({ findById: vi.fn() }));
const partnerRules = vi.hoisted(() => ({ findByDomain: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  orgDomainClaimRepository: claims,
  organizationRepository: orgs,
  userRepository: users,
  partnerSignupRuleRepository: partnerRules,
  disposableDomainRepository: {},
}));
// Mirrors orgAuthority.isCurrentOrgMember (owner, or a users[] row); the real one runs in orgDomainMembership.e2e.test.ts.
vi.mock('@bike4mind/services', () => ({
  userService: { isDisposableEmail: () => false },
  organizationService: {
    isCurrentOrgMember: (org: { userId: string; users: { userId: string }[] }, id: string) =>
      org.userId === id || org.users.some(m => m.userId === id),
  },
}));

const ORG = { id: 'org1', name: 'Acme', userId: 'owner1', seats: 5, users: [{ userId: 'm1', permissions: ['read'] }] };
const USER = { id: 'u1', email: 'dee@acme.com', username: 'dee', name: 'Dee', emailVerified: true };
const CLAIM = { id: 'c1', organizationId: 'org1', domain: 'acme.com', status: 'verified', policy: 'suggest' };

let get: Handler;

beforeAll(async () => {
  mockRefs.current = {};
  await import('@pages/api/organizations/domain-suggestions');
  get = mockRefs.current.get;
});

const fetchSuggestions = async (userId = 'u1') => {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as { user: unknown }).user = { id: userId, isAdmin: false };
  await get(req, res);
  expect(res._getStatusCode()).toBe(200);
  return res._getJSONData().suggestions;
};

beforeEach(() => {
  vi.clearAllMocks();
  users.findById.mockResolvedValue(USER);
  claims.findVerifiedJoinableByDomain.mockResolvedValue(CLAIM);
  partnerRules.findByDomain.mockResolvedValue(null);
  orgs.findById.mockResolvedValue(ORG);
});

describe('GET /api/organizations/domain-suggestions', () => {
  it('accepts a JWT session only, so an API key is never a credential here', () => {
    expect(mockRefs.configs).toHaveLength(1);
    for (const config of mockRefs.configs) expect(config).toMatchObject({ auth: 'jwtOnly' });
  });

  it.each(['suggest', 'auto-join'])('offers the org behind a verified %s claim, ids and name only', async policy => {
    claims.findVerifiedJoinableByDomain.mockResolvedValue({ ...CLAIM, policy, verificationToken: 'secret' });
    const suggestions = await fetchSuggestions();
    expect(suggestions).toEqual([{ organizationId: 'org1', organizationName: 'Acme', claimId: 'c1' }]);
    expect(claims.findVerifiedJoinableByDomain).toHaveBeenCalledWith('acme.com');
  });

  it.each([
    ['an unverified email', () => users.findById.mockResolvedValue({ ...USER, emailVerified: false })],
    ['a user with no email', () => users.findById.mockResolvedValue({ ...USER, email: undefined })],
    ['no joinable claim', () => claims.findVerifiedJoinableByDomain.mockResolvedValue(null)],
    ['a full org', () => orgs.findById.mockResolvedValue({ ...ORG, seats: 2 })],
    ['a deleted org', () => orgs.findById.mockResolvedValue(null)],
    [
      'a partner rule routing the domain elsewhere',
      () => partnerRules.findByDomain.mockResolvedValue({ domain: 'acme.com', organizationId: 'org2', enabled: true }),
    ],
  ])('returns nothing for %s', async (_label, arrange) => {
    arrange();
    expect(await fetchSuggestions()).toEqual([]);
  });

  it.each([
    ['the owner', 'owner1'],
    ['an existing member', 'm1'],
  ])('returns nothing for %s', async (_label, userId) => {
    users.findById.mockResolvedValue({ ...USER, id: userId });
    expect(await fetchSuggestions(userId)).toEqual([]);
  });
});
