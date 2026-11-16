import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const claims = vi.hoisted(() => ({
  findVerifiedByDomain: vi.fn(),
  countByOrganization: vi.fn(),
  listByOrganization: vi.fn(),
  create: vi.fn(),
  findByIdForOrg: vi.fn(),
  markVerified: vi.fn(),
  deleteSpaceClaimsByDomain: vi.fn(),
  findVerifiedSpaceClaimByDomain: vi.fn(),
  listBySpace: vi.fn(),
  findByIdForSpace: vi.fn(),
}));
const partnerRules = vi.hoisted(() => ({ findByDomain: vi.fn() }));
const disposable = vi.hoisted(() => ({ disposableSources: vi.fn() }));

const inbox = vi.hoisted(() => ({ createInboxMessage: vi.fn() }));
const spaces = vi.hoisted(() => ({ findLiveById: vi.fn(), listLiveByParentOrganization: vi.fn() }));
const users = vi.hoisted(() => ({ findById: vi.fn() }));
const orgs = vi.hoisted(() => ({ findById: vi.fn() }));
const txOrder = vi.hoisted(() => ({ events: [] as string[] }));
const notifyEmail = vi.hoisted(() => vi.fn());

vi.mock('@bike4mind/database', () => ({
  orgDomainClaimRepository: claims,
  partnerSignupRuleRepository: partnerRules,
  disposableDomainRepository: disposable,
  inboxRepository: inbox,
  spaceRepository: spaces,
  userRepository: users,
  organizationRepository: orgs,
  withTransaction: async (fn: () => Promise<unknown>) => {
    txOrder.events.push('begin');
    const result = await fn();
    txOrder.events.push('commit');
    return result;
  },
}));
vi.mock('@server/utils/spaceDomainNotifier', () => ({
  notifySpaceDomainReleasedByEmail: (...a: unknown[]) => {
    txOrder.events.push('notify-email');
    return notifyEmail(...a);
  },
}));

import {
  addDomainClaim,
  addSpaceDomainClaim,
  getTxtResolver,
  isDomainJoinable,
  joinableSpaceIdsForEmail,
  verifySpaceDomainClaim,
  defaultTxtResolver,
  recordNameFor,
  recordValueFor,
  verifyDomainClaim,
} from './orgDomainClaims';

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_ORG = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN = 'f'.repeat(32);
const pendingClaim = {
  id: 'cccccccccccccccccccccccc',
  organizationId: ORG,
  domain: 'acme.com',
  status: 'pending',
  verificationToken: TOKEN,
};

const dnsError = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  vi.clearAllMocks();
  claims.findVerifiedByDomain.mockResolvedValue(null);
  claims.countByOrganization.mockResolvedValue(0);
  claims.listByOrganization.mockResolvedValue([]);
  claims.listBySpace.mockResolvedValue([]);
  claims.create.mockImplementation(async data => ({ id: 'new', ...data }));
  claims.findByIdForOrg.mockResolvedValue(pendingClaim);
  claims.markVerified.mockResolvedValue({ ...pendingClaim, status: 'verified' });
  claims.deleteSpaceClaimsByDomain.mockResolvedValue([]);
  txOrder.events.length = 0;
  partnerRules.findByDomain.mockResolvedValue(null);
  disposable.disposableSources.mockResolvedValue([]);
});

describe('addDomainClaim', () => {
  it('creates a pending claim with a normalized domain and a random 32-hex token', async () => {
    const claim = await addDomainClaim(ORG, 'user1', ' ACME.com ');

    expect(claim).toMatchObject({ organizationId: ORG, domain: 'acme.com', status: 'pending', policy: 'off' });
    expect(claim.verificationToken).toMatch(/^[a-f0-9]{32}$/);
    const second = await addDomainClaim(ORG, 'user1', 'acme.org');
    expect(second.verificationToken).not.toBe(claim.verificationToken);
  });

  it('rejects a public mail provider', async () => {
    await expect(addDomainClaim(ORG, 'user1', 'Gmail.com')).rejects.toMatchObject({ statusCode: 400 });
    expect(claims.create).not.toHaveBeenCalled();
  });

  it('rejects a disposable domain from the database list', async () => {
    disposable.disposableSources.mockResolvedValue(['blocklist']);
    await expect(addDomainClaim(ORG, 'user1', 'throwaway.example')).rejects.toThrow(/Disposable/);
    expect(claims.create).not.toHaveBeenCalled();
  });

  it('rejects a domain another org has verified', async () => {
    claims.findVerifiedByDomain.mockResolvedValue({ organizationId: OTHER_ORG });
    await expect(addDomainClaim(ORG, 'user1', 'acme.com')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects a domain whose enabled partner rule routes to another org', async () => {
    partnerRules.findByDomain.mockResolvedValue({ organizationId: OTHER_ORG, enabled: true });
    await expect(addDomainClaim(ORG, 'user1', 'acme.com')).rejects.toThrow(/platform signup rule/);
  });

  it('allows a domain whose partner rule routes to the same org, to no org, or is disabled', async () => {
    partnerRules.findByDomain.mockResolvedValue({ organizationId: ORG, enabled: true });
    await expect(addDomainClaim(ORG, 'user1', 'acme.com')).resolves.toBeTruthy();
    partnerRules.findByDomain.mockResolvedValue({ organizationId: null, enabled: true });
    await expect(addDomainClaim(ORG, 'user1', 'acme.com')).resolves.toBeTruthy();
    partnerRules.findByDomain.mockResolvedValue({ organizationId: OTHER_ORG, enabled: false });
    await expect(addDomainClaim(ORG, 'user1', 'acme.com')).resolves.toBeTruthy();
  });

  it('enforces the per-org cap', async () => {
    claims.listByOrganization.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) => ({ ...pendingClaim, domain: `existing${index}.example` }))
    );
    await expect(addDomainClaim(ORG, 'user1', 'acme.com')).rejects.toThrow(/at most 20/);
  });

  it('maps a duplicate (org, domain) insert to a 409', async () => {
    claims.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    await expect(addDomainClaim(ORG, 'user1', 'acme.com')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('verifyDomainClaim', () => {
  const resolverReturning = (records: string[][]) => vi.fn(async () => records);

  it('verifies on an exact TXT match at the prefixed record name', async () => {
    const resolver = resolverReturning([['unrelated'], [recordValueFor(TOKEN)]]);
    const result = await verifyDomainClaim(ORG, 'cccccccccccccccccccccccc', resolver);

    expect(result.verified).toBe(true);
    expect(resolver).toHaveBeenCalledWith('_b4m-verify.acme.com');
    expect(claims.markVerified).toHaveBeenCalledWith('cccccccccccccccccccccccc', { organizationId: ORG });
  });

  it('joins chunked TXT strings before comparing', async () => {
    const value = recordValueFor(TOKEN);
    const result = await verifyDomainClaim(
      ORG,
      'cccccccccccccccccccccccc',
      resolverReturning([[value.slice(0, 10), value.slice(10)]])
    );
    expect(result.verified).toBe(true);
  });

  it.each([
    [[[recordValueFor('0'.repeat(32))]]],
    [[[`${recordValueFor(TOKEN)} `]]],
    [[[recordValueFor(TOKEN).toUpperCase()]]],
  ])('does not verify a mismatched record %j', async records => {
    const result = await verifyDomainClaim(ORG, 'cccccccccccccccccccccccc', resolverReturning(records));
    expect(result).toEqual({ verified: false, reason: expect.stringMatching(/does not match/) });
    expect(claims.markVerified).not.toHaveBeenCalled();
  });

  it.each([
    ['ENODATA', /No TXT record/],
    ['ENOTFOUND', /No TXT record/],
    ['ETIMEOUT', /timed out/],
    ['ESERVFAIL', /lookup failed/],
  ])('reports %s as unverified with a reason', async (code, reason) => {
    const result = await verifyDomainClaim(ORG, 'cccccccccccccccccccccccc', vi.fn().mockRejectedValue(dnsError(code)));
    expect(result).toEqual({ verified: false, reason: expect.stringMatching(reason) });
    expect(claims.markVerified).not.toHaveBeenCalled();
  });

  it('returns an already verified claim without a lookup', async () => {
    claims.findByIdForOrg.mockResolvedValue({ ...pendingClaim, status: 'verified' });
    const resolver = resolverReturning([]);
    await expect(verifyDomainClaim(ORG, 'cccccccccccccccccccccccc', resolver)).resolves.toMatchObject({
      verified: true,
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('404s a claim outside the org', async () => {
    claims.findByIdForOrg.mockResolvedValue(null);
    await expect(verifyDomainClaim(ORG, 'cccccccccccccccccccccccc', resolverReturning([]))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('re-checks claim rules before the lookup', async () => {
    claims.findVerifiedByDomain.mockResolvedValue({ organizationId: OTHER_ORG });
    const resolver = resolverReturning([[recordValueFor(TOKEN)]]);
    await expect(verifyDomainClaim(ORG, 'cccccccccccccccccccccccc', resolver)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(resolver).not.toHaveBeenCalled();

    claims.findVerifiedByDomain.mockResolvedValue(null);
    partnerRules.findByDomain.mockResolvedValue({ organizationId: OTHER_ORG, enabled: true });
    await expect(verifyDomainClaim(ORG, 'cccccccccccccccccccccccc', resolver)).rejects.toMatchObject({
      statusCode: 409,
    });

    partnerRules.findByDomain.mockResolvedValue({ organizationId: OTHER_ORG, enabled: false });
    await expect(verifyDomainClaim(ORG, 'cccccccccccccccccccccccc', resolver)).resolves.toMatchObject({
      verified: true,
    });
  });

  it('maps a lost verify race to a 409', async () => {
    claims.markVerified.mockResolvedValue('conflict');
    await expect(
      verifyDomainClaim(ORG, 'cccccccccccccccccccccccc', resolverReturning([[recordValueFor(TOKEN)]]))
    ).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('404s a claim deleted between load and mark', async () => {
    claims.markVerified.mockResolvedValue(null);
    await expect(
      verifyDomainClaim(ORG, 'cccccccccccccccccccccccc', resolverReturning([[recordValueFor(TOKEN)]]))
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('getTxtResolver', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('uses real DNS unless the stub flag is set locally', () => {
    process.env.B4M_DOMAIN_VERIFY_STUB = '1';
    process.env.IS_LOCAL = 'false';
    process.env.NODE_ENV = 'production';
    expect(getTxtResolver(pendingClaim)).toBe(defaultTxtResolver);

    process.env.IS_LOCAL = 'true';
    process.env.B4M_SELF_HOST = 'true';
    expect(getTxtResolver(pendingClaim)).toBe(defaultTxtResolver);
  });

  it('stubs the expected record locally', async () => {
    process.env.B4M_DOMAIN_VERIFY_STUB = '1';
    process.env.IS_LOCAL = 'true';
    delete process.env.B4M_SELF_HOST;
    const resolver = getTxtResolver(pendingClaim);
    expect(resolver).not.toBe(defaultTxtResolver);
    await expect(resolver(recordNameFor('acme.com'))).resolves.toEqual([[recordValueFor(TOKEN)]]);
  });
});

it('rejects an existing legacy alias before create', async () => {
  claims.listByOrganization.mockResolvedValue([{ ...pendingClaim, organizationId: ORG.toUpperCase() }]);
  await expect(addDomainClaim(ORG.toUpperCase(), 'user1', 'acme.com')).rejects.toMatchObject({ statusCode: 409 });
  expect(claims.listByOrganization).toHaveBeenCalledWith(ORG);
  expect(claims.create).not.toHaveBeenCalled();
});

it('preserves a same-organization partner reservation written with an uppercase ID', async () => {
  partnerRules.findByDomain.mockResolvedValue({ organizationId: ORG.toUpperCase(), enabled: true });
  await expect(addDomainClaim(ORG.toUpperCase(), 'user1', 'acme.com')).resolves.toMatchObject({ organizationId: ORG });
  expect(claims.create).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG }));
});

const SPACE = 'dddddddddddddddddddddddd';
const OTHER_SPACE = 'eeeeeeeeeeeeeeeeeeeeeeee';
const spaceClaim = {
  id: 'ffffffffffffffffffffffff',
  spaceId: SPACE,
  domain: 'acme.com',
  status: 'pending',
  verificationToken: TOKEN,
};

describe('claim table for a Space owner', () => {
  it('lets a Space claim a free domain', async () => {
    await expect(addSpaceDomainClaim(SPACE, 'user1', 'acme.com')).resolves.toMatchObject({
      spaceId: SPACE,
      status: 'pending',
      policy: 'off',
    });
    expect(claims.create).toHaveBeenCalledWith(expect.not.objectContaining({ organizationId: expect.anything() }));
  });

  it('refuses a domain an organization holds, with a message that names no org', async () => {
    claims.findVerifiedByDomain.mockResolvedValue({ organizationId: ORG });
    await expect(addSpaceDomainClaim(SPACE, 'user1', 'acme.com')).rejects.toMatchObject({
      statusCode: 409,
      message: 'Domain already claimed by an organization',
    });
  });

  it('refuses a domain another Space holds, and accepts the same Space', async () => {
    claims.findVerifiedByDomain.mockResolvedValue({ spaceId: OTHER_SPACE });
    await expect(addSpaceDomainClaim(SPACE, 'user1', 'acme.com')).rejects.toMatchObject({ statusCode: 409 });
    claims.findVerifiedByDomain.mockResolvedValue({ spaceId: SPACE });
    await expect(addSpaceDomainClaim(SPACE, 'user1', 'acme.com')).resolves.toBeTruthy();
  });

  it('refuses a Space on any enabled partner rule that names an org', async () => {
    partnerRules.findByDomain.mockResolvedValue({ organizationId: ORG, enabled: true });
    await expect(addSpaceDomainClaim(SPACE, 'user1', 'acme.com')).rejects.toThrow(/platform signup rule/);
    partnerRules.findByDomain.mockResolvedValue({ organizationId: null, enabled: true });
    await expect(addSpaceDomainClaim(SPACE, 'user1', 'acme.com')).resolves.toBeTruthy();
  });

  it('lets an org add a claim on a domain a Space holds verified', async () => {
    claims.findVerifiedByDomain.mockResolvedValue({ spaceId: SPACE });
    await expect(addDomainClaim(ORG, 'user1', 'acme.com')).resolves.toBeTruthy();
    expect(claims.deleteSpaceClaimsByDomain).not.toHaveBeenCalled();
    expect(txOrder.events).toEqual([]);
  });
});

describe('org verify releases Space claims', () => {
  const resolver = vi.fn(async () => [[recordValueFor(TOKEN)]]);

  it('deletes the Space claims inside one transaction before marking, then notifies after commit', async () => {
    claims.findVerifiedByDomain.mockResolvedValue({ spaceId: SPACE });
    claims.deleteSpaceClaimsByDomain.mockImplementation(async () => {
      txOrder.events.push('release');
      return [{ ...spaceClaim, status: 'verified' }];
    });
    claims.markVerified.mockImplementation(async () => {
      txOrder.events.push('mark');
      return { ...pendingClaim, status: 'verified' };
    });
    spaces.findLiveById.mockResolvedValue({ id: SPACE, name: 'Team', ownerUserId: 'owner1' });
    inbox.createInboxMessage.mockImplementation(async () => {
      txOrder.events.push('notify-inbox');
    });

    const outcome = await verifyDomainClaim(ORG, 'cccccccccccccccccccccccc', resolver);

    expect(outcome).toMatchObject({ verified: true });
    expect(txOrder.events).toEqual(['begin', 'release', 'mark', 'commit', 'notify-inbox', 'notify-email']);
    expect(claims.deleteSpaceClaimsByDomain).toHaveBeenCalledWith('acme.com');
    const [receiverArgs] = inbox.createInboxMessage.mock.calls[0];
    expect(receiverArgs).toMatchObject({ receiverId: 'owner1' });
    expect(JSON.stringify(receiverArgs)).toContain('Team');
    expect(JSON.stringify(receiverArgs)).not.toContain(ORG);
    expect(notifyEmail).toHaveBeenCalledWith('owner1', 'Team', 'acme.com', expect.anything());
  });

  it('keeps the verify when a notification fails', async () => {
    claims.deleteSpaceClaimsByDomain.mockResolvedValue([{ ...spaceClaim, status: 'verified' }]);
    spaces.findLiveById.mockResolvedValue({ id: SPACE, name: 'Team', ownerUserId: 'owner1' });
    inbox.createInboxMessage.mockRejectedValueOnce(new Error('inbox down'));
    notifyEmail.mockRejectedValueOnce(new Error('smtp down'));
    await expect(verifyDomainClaim(ORG, 'cccccccccccccccccccccccc', resolver)).resolves.toMatchObject({
      verified: true,
    });
  });

  it('does not release or notify when the TXT record does not match', async () => {
    const miss = vi.fn(async () => [['nope']]);
    await expect(verifyDomainClaim(ORG, 'cccccccccccccccccccccccc', miss)).resolves.toMatchObject({ verified: false });
    expect(claims.deleteSpaceClaimsByDomain).not.toHaveBeenCalled();
  });

  it('a Space verify releases nothing', async () => {
    claims.findByIdForSpace.mockResolvedValue(spaceClaim);
    claims.markVerified.mockResolvedValue({ ...spaceClaim, status: 'verified' });
    await expect(verifySpaceDomainClaim(SPACE, spaceClaim.id, resolver)).resolves.toMatchObject({ verified: true });
    expect(claims.deleteSpaceClaimsByDomain).not.toHaveBeenCalled();
    expect(claims.markVerified).toHaveBeenCalledWith(spaceClaim.id, { spaceId: SPACE });
  });

  it('refuses a Space verify once an org holds the domain', async () => {
    claims.findByIdForSpace.mockResolvedValue(spaceClaim);
    claims.findVerifiedByDomain.mockResolvedValue({ organizationId: ORG });
    await expect(verifySpaceDomainClaim(SPACE, spaceClaim.id, resolver)).rejects.toMatchObject({ statusCode: 409 });
    expect(claims.markVerified).not.toHaveBeenCalled();
  });
});

describe('isDomainJoinable and joinableSpaceIdsForEmail', () => {
  const childSpace = { id: SPACE, ownerUserId: 'owner1', parentOrganizationId: ORG } as never;
  const orgClaim = { id: 'c1', organizationId: ORG, domain: 'acme.com', status: 'verified', policy: 'suggest' };

  beforeEach(() => {
    claims.findVerifiedSpaceClaimByDomain.mockResolvedValue(null);
    claims.findVerifiedJoinableByDomain = vi.fn().mockResolvedValue(null);
    users.findById.mockResolvedValue({ id: 'owner1' });
    orgs.findById.mockResolvedValue({ id: ORG, userId: 'owner1', adminUserIds: [] });
    spaces.listLiveByParentOrganization.mockResolvedValue([]);
  });

  it('accepts the Space own verified suggest claim, exact domain only', async () => {
    claims.findVerifiedSpaceClaimByDomain.mockImplementation(async (d: string) =>
      d === 'acme.com' ? { spaceId: SPACE } : null
    );
    await expect(isDomainJoinable({ id: SPACE, parentOrganizationId: null } as never, 'a@acme.com')).resolves.toBe(
      true
    );
    await expect(isDomainJoinable({ id: SPACE, parentOrganizationId: null } as never, 'a@mail.acme.com')).resolves.toBe(
      false
    );
    await expect(
      isDomainJoinable({ id: SPACE, parentOrganizationId: null } as never, 'a@acme.com.evil.io')
    ).resolves.toBe(false);
  });

  it('ignores a claim that belongs to another Space', async () => {
    claims.findVerifiedSpaceClaimByDomain.mockResolvedValue({ spaceId: OTHER_SPACE });
    await expect(isDomainJoinable({ id: SPACE, parentOrganizationId: null } as never, 'a@acme.com')).resolves.toBe(
      false
    );
  });

  it('inherits the parent org joinable claim while the owner still administers it', async () => {
    claims.findVerifiedJoinableByDomain.mockResolvedValue(orgClaim);
    await expect(isDomainJoinable(childSpace, 'a@acme.com')).resolves.toBe(true);
  });

  it('refuses inheritance when the parent claim is off (not returned as joinable)', async () => {
    await expect(isDomainJoinable(childSpace, 'a@acme.com')).resolves.toBe(false);
  });

  it('refuses inheritance once the owner no longer administers the parent', async () => {
    claims.findVerifiedJoinableByDomain.mockResolvedValue(orgClaim);
    orgs.findById.mockResolvedValue({ id: ORG, userId: 'someone-else', adminUserIds: [] });
    await expect(isDomainJoinable(childSpace, 'a@acme.com')).resolves.toBe(false);
  });

  it('refuses a Space with no parent or a different parent org', async () => {
    claims.findVerifiedJoinableByDomain.mockResolvedValue(orgClaim);
    await expect(
      isDomainJoinable({ ...(childSpace as object), parentOrganizationId: null } as never, 'a@acme.com')
    ).resolves.toBe(false);
    await expect(
      isDomainJoinable({ ...(childSpace as object), parentOrganizationId: OTHER_ORG } as never, 'a@acme.com')
    ).resolves.toBe(false);
  });

  it('lists the own-claim Space plus administered children of a joinable org claim', async () => {
    claims.findVerifiedSpaceClaimByDomain.mockResolvedValue({ spaceId: OTHER_SPACE });
    claims.findVerifiedJoinableByDomain.mockResolvedValue(orgClaim);
    spaces.listLiveByParentOrganization.mockResolvedValue([childSpace]);
    await expect(joinableSpaceIdsForEmail('a@acme.com')).resolves.toEqual([OTHER_SPACE, SPACE]);
    await expect(joinableSpaceIdsForEmail('nonsense')).resolves.toEqual([]);
  });
});
