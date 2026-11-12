import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@bike4mind/common';

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
const orgs = vi.hoisted(() => ({
  findById: vi.fn(),
  addMemberIfUnderCeiling: vi.fn(),
  ensureUserDetails: vi.fn(),
}));
const users = vi.hoisted(() => ({ findById: vi.fn(), update: vi.fn() }));
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
const CLAIM = {
  id: 'c1',
  organizationId: 'org1',
  domain: 'acme.com',
  status: 'verified',
  policy: 'suggest',
};

let join: Handler;

beforeAll(async () => {
  mockRefs.current = {};
  await import('@pages/api/organizations/[id]/domain-join');
  join = mockRefs.current.post;
});

const call = (query: Record<string, unknown> = { id: 'org1' }, userId = 'u1') => {
  const { req, res } = createMocks({ method: 'POST', query: query as Record<string, string> });
  (req as unknown as { user: unknown }).user = { id: userId, isAdmin: false };
  return { res, run: () => join(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  users.findById.mockResolvedValue(USER);
  claims.findVerifiedJoinableByDomain.mockResolvedValue(CLAIM);
  partnerRules.findByDomain.mockResolvedValue(null);
  orgs.findById.mockResolvedValue(ORG);
  orgs.addMemberIfUnderCeiling.mockResolvedValue(ORG);
});

describe('POST /api/organizations/:id/domain-join', () => {
  it('accepts a JWT session only, so an API key is never a credential here', () => {
    expect(mockRefs.configs).toHaveLength(1);
    for (const config of mockRefs.configs) expect(config).toMatchObject({ auth: 'jwtOnly' });
  });

  it('adds the user as a read-only member, points the user at the org and seeds userDetails', async () => {
    const { res, run } = call();
    await run();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ joined: true, organizationId: 'org1', organizationName: 'Acme' });
    expect(orgs.addMemberIfUnderCeiling).toHaveBeenCalledWith('org1', { userId: 'u1', permissions: ['read'] });
    expect(users.update).toHaveBeenCalledWith({ id: 'u1', organizationId: 'org1' });
    expect(orgs.ensureUserDetails).toHaveBeenCalledWith('org1', { id: 'u1', email: 'dee@acme.com', name: 'Dee' });
  });

  it('looks the claim up by the email on the stored user, not anything in the request', async () => {
    users.findById.mockResolvedValue({ ...USER, email: 'Dee@Acme.COM' });
    await call().run();
    expect(claims.findVerifiedJoinableByDomain).toHaveBeenCalledWith('acme.com');
  });

  it.each([
    ['the owner', { ...USER, id: 'owner1' }],
    ['an existing member', { ...USER, id: 'm1' }],
  ])('is an idempotent 200 for %s without touching the roster', async (_label, user) => {
    users.findById.mockResolvedValue(user);
    const { res, run } = call({ id: 'org1' }, user.id);
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().joined).toBe(false);
    expect(orgs.addMemberIfUnderCeiling).not.toHaveBeenCalled();
  });

  it('is an idempotent 200 when a concurrent join already added the user', async () => {
    orgs.addMemberIfUnderCeiling.mockResolvedValue(null);
    orgs.findById
      .mockResolvedValueOnce(ORG)
      .mockResolvedValueOnce({ ...ORG, users: [...ORG.users, { userId: 'u1', permissions: ['read'] }] });
    const { res, run } = call();
    await run();
    expect(res._getJSONData().joined).toBe(false);
    expect(users.update).not.toHaveBeenCalled();
  });

  it('refuses with 409 when the org has no free seat and never raises the ceiling', async () => {
    orgs.addMemberIfUnderCeiling.mockResolvedValue(null);
    await expect(call().run()).rejects.toThrow(ConflictError);
    await expect(call().run()).rejects.toThrow('Organization is at full capacity');
    expect(users.update).not.toHaveBeenCalled();
  });

  it.each([
    ['an unverified email', () => users.findById.mockResolvedValue({ ...USER, emailVerified: false })],
    ['a missing email', () => users.findById.mockResolvedValue({ ...USER, email: null })],
    [
      'a domain with no joinable claim (pending, or policy off)',
      () => claims.findVerifiedJoinableByDomain.mockResolvedValue(null),
    ],
    [
      'a claim owned by a different org',
      () => claims.findVerifiedJoinableByDomain.mockResolvedValue({ ...CLAIM, organizationId: 'org2' }),
    ],
    [
      'a partner rule routing the domain to another org',
      () => partnerRules.findByDomain.mockResolvedValue({ domain: 'acme.com', organizationId: 'org2', enabled: true }),
    ],
  ])('refuses %s with 403 before touching the roster', async (_label, arrange) => {
    arrange();
    await expect(call().run()).rejects.toThrow(ForbiddenError);
    expect(orgs.addMemberIfUnderCeiling).not.toHaveBeenCalled();
  });

  it('allows a partner rule that routes the domain to the same org', async () => {
    partnerRules.findByDomain.mockResolvedValue({ domain: 'acme.com', organizationId: 'org1', enabled: true });
    const { res, run } = call();
    await run();
    expect(res._getJSONData().joined).toBe(true);
  });

  it('404s when the org is gone', async () => {
    orgs.findById.mockResolvedValue(null);
    await expect(call().run()).rejects.toThrow(NotFoundError);
  });

  it('400s without an org id', async () => {
    await expect(call({}).run()).rejects.toThrow(BadRequestError);
  });
});
