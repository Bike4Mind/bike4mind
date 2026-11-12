import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const claims = vi.hoisted(() => ({
  findVerifiedByDomain: vi.fn(),
  countByOrganization: vi.fn(),
  create: vi.fn(),
  findByIdForOrg: vi.fn(),
  markVerified: vi.fn(),
}));
const partnerRules = vi.hoisted(() => ({ findByDomain: vi.fn() }));
const disposable = vi.hoisted(() => ({ disposableSources: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  orgDomainClaimRepository: claims,
  partnerSignupRuleRepository: partnerRules,
  disposableDomainRepository: disposable,
}));

import {
  addDomainClaim,
  getTxtResolver,
  defaultTxtResolver,
  recordNameFor,
  recordValueFor,
  verifyDomainClaim,
} from './orgDomainClaims';

const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const TOKEN = 'f'.repeat(32);
const pendingClaim = {
  id: 'claim1',
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
  claims.create.mockImplementation(async data => ({ id: 'new', ...data }));
  claims.findByIdForOrg.mockResolvedValue(pendingClaim);
  claims.markVerified.mockResolvedValue({ ...pendingClaim, status: 'verified' });
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
    claims.countByOrganization.mockResolvedValue(20);
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
    const result = await verifyDomainClaim(ORG, 'claim1', resolver);

    expect(result.verified).toBe(true);
    expect(resolver).toHaveBeenCalledWith('_b4m-verify.acme.com');
    expect(claims.markVerified).toHaveBeenCalledWith('claim1', ORG);
  });

  it('joins chunked TXT strings before comparing', async () => {
    const value = recordValueFor(TOKEN);
    const result = await verifyDomainClaim(ORG, 'claim1', resolverReturning([[value.slice(0, 10), value.slice(10)]]));
    expect(result.verified).toBe(true);
  });

  it.each([
    [[[recordValueFor('0'.repeat(32))]]],
    [[[`${recordValueFor(TOKEN)} `]]],
    [[[recordValueFor(TOKEN).toUpperCase()]]],
  ])('does not verify a mismatched record %j', async records => {
    const result = await verifyDomainClaim(ORG, 'claim1', resolverReturning(records));
    expect(result).toEqual({ verified: false, reason: expect.stringMatching(/does not match/) });
    expect(claims.markVerified).not.toHaveBeenCalled();
  });

  it.each([
    ['ENODATA', /No TXT record/],
    ['ENOTFOUND', /No TXT record/],
    ['ETIMEOUT', /timed out/],
    ['ESERVFAIL', /lookup failed/],
  ])('reports %s as unverified with a reason', async (code, reason) => {
    const result = await verifyDomainClaim(ORG, 'claim1', vi.fn().mockRejectedValue(dnsError(code)));
    expect(result).toEqual({ verified: false, reason: expect.stringMatching(reason) });
    expect(claims.markVerified).not.toHaveBeenCalled();
  });

  it('returns an already verified claim without a lookup', async () => {
    claims.findByIdForOrg.mockResolvedValue({ ...pendingClaim, status: 'verified' });
    const resolver = resolverReturning([]);
    await expect(verifyDomainClaim(ORG, 'claim1', resolver)).resolves.toMatchObject({ verified: true });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('404s a claim outside the org', async () => {
    claims.findByIdForOrg.mockResolvedValue(null);
    await expect(verifyDomainClaim(ORG, 'claim1', resolverReturning([]))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('re-checks claim rules before the lookup', async () => {
    claims.findVerifiedByDomain.mockResolvedValue({ organizationId: OTHER_ORG });
    const resolver = resolverReturning([[recordValueFor(TOKEN)]]);
    await expect(verifyDomainClaim(ORG, 'claim1', resolver)).rejects.toMatchObject({ statusCode: 409 });
    expect(resolver).not.toHaveBeenCalled();

    claims.findVerifiedByDomain.mockResolvedValue(null);
    partnerRules.findByDomain.mockResolvedValue({ organizationId: OTHER_ORG, enabled: true });
    await expect(verifyDomainClaim(ORG, 'claim1', resolver)).rejects.toMatchObject({ statusCode: 409 });

    partnerRules.findByDomain.mockResolvedValue({ organizationId: OTHER_ORG, enabled: false });
    await expect(verifyDomainClaim(ORG, 'claim1', resolver)).resolves.toMatchObject({ verified: true });
  });

  it('maps a lost verify race to a 409', async () => {
    claims.markVerified.mockResolvedValue('conflict');
    await expect(verifyDomainClaim(ORG, 'claim1', resolverReturning([[recordValueFor(TOKEN)]]))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('404s a claim deleted between load and mark', async () => {
    claims.markVerified.mockResolvedValue(null);
    await expect(verifyDomainClaim(ORG, 'claim1', resolverReturning([[recordValueFor(TOKEN)]]))).rejects.toMatchObject({
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
