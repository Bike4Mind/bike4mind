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

const claims = vi.hoisted(() => ({
  listByOrganization: vi.fn(),
  countByOrganization: vi.fn(),
  create: vi.fn(),
  findByIdForOrg: vi.fn(),
  findVerifiedByDomain: vi.fn(),
  markVerified: vi.fn(),
  updatePolicy: vi.fn(),
  deleteForOrg: vi.fn(),
}));
const orgs = vi.hoisted(() => ({ findById: vi.fn() }));
const partnerRules = vi.hoisted(() => ({ findByDomain: vi.fn() }));
const disposable = vi.hoisted(() => ({ disposableSources: vi.fn() }));
const resolveTxt = vi.hoisted(() => vi.fn());

vi.mock('@bike4mind/database', () => ({
  orgDomainClaimRepository: claims,
  organizationRepository: orgs,
  partnerSignupRuleRepository: partnerRules,
  disposableDomainRepository: disposable,
}));
vi.mock('@bike4mind/services', () => ({ userService: { isDisposableEmail: () => false } }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));
vi.mock('dns/promises', () => ({
  Resolver: class {
    resolveTxt = resolveTxt;
  },
}));

import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

const TOKEN = 'a'.repeat(32);
const ORG = {
  id: 'org1',
  name: 'Acme',
  userId: 'owner1',
  adminUserIds: ['mgr1'],
  users: [
    { userId: 'mgr1', permissions: ['read'] },
    { userId: 'member1', permissions: ['read', 'update'] },
  ],
};
const claim = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  organizationId: 'org1',
  domain: 'acme.com',
  status: 'pending',
  verificationToken: TOKEN,
  verifiedAt: null,
  policy: 'off',
  createdBy: 'owner1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

let collection: Record<string, Handler>;
let item: Record<string, Handler>;
let verify: Record<string, Handler>;

beforeAll(async () => {
  mockRefs.current = {};
  await import('@pages/api/organizations/[id]/domains/index');
  collection = mockRefs.current;
  mockRefs.current = {};
  await import('@pages/api/organizations/[id]/domains/[claimId]/index');
  item = mockRefs.current;
  mockRefs.current = {};
  await import('@pages/api/organizations/[id]/domains/[claimId]/verify');
  verify = mockRefs.current;
});

const call = (
  handler: Handler,
  {
    userId = 'owner1',
    isAdmin = false,
    query = { id: 'org1', claimId: 'c1' } as Record<string, unknown>,
    body,
  }: { userId?: string; isAdmin?: boolean; query?: Record<string, unknown>; body?: unknown } = {}
) => {
  const { req, res } = createMocks({ query: query as Record<string, string>, body: body as Record<string, unknown> });
  (req as unknown as { user: unknown }).user = { id: userId, isAdmin };
  return { res, run: () => handler(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  orgs.findById.mockResolvedValue(ORG);
  claims.findVerifiedByDomain.mockResolvedValue(null);
  claims.countByOrganization.mockResolvedValue(0);
  partnerRules.findByDomain.mockResolvedValue(null);
  disposable.disposableSources.mockResolvedValue([]);
});

describe('org domain routes - access gate', () => {
  it('accepts a JWT session only, so an API key is never a credential here', () => {
    expect(mockRefs.configs).toHaveLength(3);
    for (const config of mockRefs.configs) expect(config).toMatchObject({ auth: 'jwtOnly' });
  });

  it.each([
    ['owner', 'owner1', false],
    ['manager', 'mgr1', false],
    ['platform admin', 'outsider', true],
  ])('lets the %s list claims, with TXT instructions and no raw token', async (_label, userId, isAdmin) => {
    claims.listByOrganization.mockResolvedValue([claim(), claim({ id: 'c2', domain: 'b.com', status: 'verified' })]);

    const { res, run } = call(collection.get, { userId, isAdmin });
    await run();

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.claims[0]).toMatchObject({
      id: 'c1',
      recordName: '_b4m-verify.acme.com',
      recordValue: `b4m-domain-verification=${TOKEN}`,
    });
    expect(body.claims[1]).toMatchObject({ id: 'c2', recordName: null, recordValue: null });
    expect(JSON.stringify(body)).not.toContain('verificationToken');
  });

  it.each([
    ['plain member', 'member1'],
    ['non-member', 'stranger'],
  ])('refuses a %s on every verb before reading any claim', async (_label, userId) => {
    for (const handler of [collection.get, collection.post, item.patch, item.delete, verify.post]) {
      const { run } = call(handler, { userId, body: { domain: 'acme.com', policy: 'off' } });
      await expect(run()).rejects.toThrow(ForbiddenError);
    }
    expect(claims.listByOrganization).not.toHaveBeenCalled();
    expect(claims.findByIdForOrg).not.toHaveBeenCalled();
    expect(claims.create).not.toHaveBeenCalled();
  });

  it('refuses every verb on a personal organization before reading any claim', async () => {
    orgs.findById.mockResolvedValue({ ...ORG, personal: true });
    for (const handler of [collection.get, collection.post, item.patch, item.delete, verify.post]) {
      const { run } = call(handler, { body: { domain: 'acme.com', policy: 'off' } });
      await expect(run()).rejects.toThrow(/Personal organizations cannot claim domains/);
    }
    expect(claims.listByOrganization).not.toHaveBeenCalled();
    expect(claims.findByIdForOrg).not.toHaveBeenCalled();
    expect(claims.create).not.toHaveBeenCalled();
  });

  it('404s an unknown organization', async () => {
    orgs.findById.mockResolvedValue(null);
    await expect(call(collection.get).run()).rejects.toThrow(NotFoundError);
  });

  it('400s a missing organization or claim id', async () => {
    await expect(call(collection.get, { query: {} }).run()).rejects.toThrow(BadRequestError);
    await expect(call(item.patch, { query: { id: 'org1' }, body: { policy: 'off' } }).run()).rejects.toThrow(
      BadRequestError
    );
    await expect(call(verify.post, { query: { id: 'org1', claimId: ['a', 'b'] } }).run()).rejects.toThrow(
      BadRequestError
    );
  });
});

describe('POST /api/organizations/[id]/domains', () => {
  it('adds a pending claim and audits it', async () => {
    claims.create.mockImplementation(async (doc: Record<string, unknown>) => claim(doc));

    const { res, run } = call(collection.post, { body: { domain: ' ACME.com ' } });
    await run();

    expect(res._getStatusCode()).toBe(201);
    expect(claims.create).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org1', domain: 'acme.com' }));
    expect(res._getJSONData().claim.recordName).toBe('_b4m-verify.acme.com');
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'org.domain.added', actorScope: 'organization' })
    );
  });

  it.each([[{ domain: '*.acme.com' }], [{ domain: 'nodot' }], [{}], [{ domain: 'acme.com', extra: 1 }]])(
    'rejects %j with a ZodError (422)',
    async body => {
      await expect(call(collection.post, { body }).run()).rejects.toMatchObject({ name: 'ZodError' });
      expect(claims.create).not.toHaveBeenCalled();
    }
  );

  it('409s a domain another org has verified', async () => {
    claims.findVerifiedByDomain.mockResolvedValue(claim({ organizationId: 'org2', status: 'verified' }));
    await expect(call(collection.post, { body: { domain: 'acme.com' } }).run()).rejects.toThrow(ConflictError);
    expect(claims.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/organizations/[id]/domains/[claimId]', () => {
  it('404s a claim id that belongs to another org', async () => {
    claims.findByIdForOrg.mockResolvedValue(null);
    await expect(call(item.patch, { body: { policy: 'off' } }).run()).rejects.toThrow(NotFoundError);
    expect(claims.findByIdForOrg).toHaveBeenCalledWith('c1', 'org1');
    expect(claims.updatePolicy).not.toHaveBeenCalled();
  });

  it('400s a join policy on a pending claim', async () => {
    claims.findByIdForOrg.mockResolvedValue(claim());
    await expect(call(item.patch, { body: { policy: 'auto-join' } }).run()).rejects.toThrow(BadRequestError);
    expect(claims.updatePolicy).not.toHaveBeenCalled();
  });

  it('sets the policy on a verified claim and audits only the policy change', async () => {
    claims.findByIdForOrg.mockResolvedValue(claim({ status: 'verified' }));
    claims.updatePolicy.mockResolvedValue(claim({ status: 'verified', policy: 'auto-join' }));

    const { res, run } = call(item.patch, { userId: 'mgr1', body: { policy: 'auto-join' } });
    await run();

    expect(res._getStatusCode()).toBe(200);
    expect(claims.updatePolicy).toHaveBeenCalledWith('c1', 'org1', { policy: 'auto-join' });
    expect(res._getJSONData().claim).toMatchObject({ policy: 'auto-join' });
    expect(res._getJSONData().claim).not.toHaveProperty('defaultRole');
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ changes: [{ field: 'policy', before: 'off', after: 'auto-join' }] })
    );
  });

  it.each([
    [{}],
    [{ policy: 'everyone' }],
    [{ defaultRole: 'viewer' }],
    [{ policy: 'auto-join', defaultRole: 'viewer' }],
    [{ policy: 'off', status: 'verified' }],
  ])('rejects %j with a ZodError (422)', async body => {
    await expect(call(item.patch, { body }).run()).rejects.toMatchObject({ name: 'ZodError' });
  });
});

describe('DELETE /api/organizations/[id]/domains/[claimId]', () => {
  it('removes the claim scoped to the org', async () => {
    claims.findByIdForOrg.mockResolvedValue(claim());
    claims.deleteForOrg.mockResolvedValue(true);

    const { res, run } = call(item.delete);
    await run();

    expect(res._getStatusCode()).toBe(204);
    expect(claims.deleteForOrg).toHaveBeenCalledWith('c1', 'org1');
  });

  it('404s a claim of another org', async () => {
    claims.findByIdForOrg.mockResolvedValue(null);
    await expect(call(item.delete).run()).rejects.toThrow(NotFoundError);
    expect(claims.deleteForOrg).not.toHaveBeenCalled();
  });
});

describe('POST /api/organizations/[id]/domains/[claimId]/verify', () => {
  it('verifies when the TXT record matches', async () => {
    claims.findByIdForOrg.mockResolvedValue(claim());
    resolveTxt.mockResolvedValue([['b4m-domain-verification=', TOKEN]]);
    claims.markVerified.mockResolvedValue(claim({ status: 'verified', verifiedAt: new Date() }));

    const { res, run } = call(verify.post);
    await run();

    expect(resolveTxt).toHaveBeenCalledWith('_b4m-verify.acme.com');
    expect(claims.markVerified).toHaveBeenCalledWith('c1', 'org1');
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ verified: true, claim: { status: 'verified', recordValue: null } });
  });

  it('answers 200 with a reason, not an error, when no record exists', async () => {
    claims.findByIdForOrg.mockResolvedValue(claim());
    resolveTxt.mockRejectedValue(Object.assign(new Error('nodata'), { code: 'ENODATA' }));

    const { res, run } = call(verify.post);
    await run();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ verified: false, reason: 'No TXT record found yet' });
    expect(claims.markVerified).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('409s when another org wins the verify race', async () => {
    claims.findByIdForOrg.mockResolvedValue(claim());
    resolveTxt.mockResolvedValue([[`b4m-domain-verification=${TOKEN}`]]);
    claims.markVerified.mockResolvedValue('conflict');

    await expect(call(verify.post).run()).rejects.toThrow(ConflictError);
  });
});
