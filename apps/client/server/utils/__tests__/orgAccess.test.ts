import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/common';

const mockFindById = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
}));

// resolveBillingOrgId delegates the membership decision to the canonical org gate; mock it so this
// suite verifies only the tri-state routing and that the gate is consulted (the gate itself has its
// own tests in resolveActiveOrg.test.ts).
const mockResolveActiveOrg = vi.fn();
vi.mock('../resolveActiveOrg', () => ({
  resolveActiveOrg: (...a: unknown[]) => mockResolveActiveOrg(...a),
}));

import { verifyOrgAccess, resolveBillingOrgId } from '../orgAccess';

// Valid 24-hex ObjectId strings (pass Types.ObjectId round-trip validation).
const ORG = '650000000000000000000abc';
const OWNER = '650000000000000000000111';
const MANAGER = '650000000000000000000222';
const STRANGER = '650000000000000000000333';
const OTHER_ORG = '650000000000000000000def';

const org = { id: ORG, userId: OWNER, managerId: MANAGER };

describe('verifyOrgAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(org);
  });

  it('rejects an invalid ObjectId without touching the DB', async () => {
    await expect(verifyOrgAccess({ id: OWNER, isAdmin: false }, 'not-an-object-id')).rejects.toBeInstanceOf(
      BadRequestError
    );
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('grants an admin access to any org', async () => {
    const result = await verifyOrgAccess({ id: STRANGER, isAdmin: true }, ORG);
    expect(result).toBe(org);
  });

  it('404s an admin when the org does not exist', async () => {
    mockFindById.mockResolvedValue(null);
    await expect(verifyOrgAccess({ id: STRANGER, isAdmin: true }, ORG)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('grants the org owner', async () => {
    const result = await verifyOrgAccess({ id: OWNER, isAdmin: false }, ORG);
    expect(result).toBe(org);
  });

  it('grants the team manager', async () => {
    const result = await verifyOrgAccess({ id: MANAGER, isAdmin: false }, ORG);
    expect(result).toBe(org);
  });

  it('404s a non-member (same error as missing, to prevent enumeration)', async () => {
    await expect(verifyOrgAccess({ id: STRANGER, isAdmin: false }, ORG)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('404s a non-admin when the org does not exist', async () => {
    mockFindById.mockResolvedValue(null);
    await expect(verifyOrgAccess({ id: OWNER, isAdmin: false }, ORG)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('resolveBillingOrgId', () => {
  const warn = vi.fn();
  const asReq = (user: Record<string, unknown>) => ({ user, logger: { warn } }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null (personal) for an explicit null request, without consulting the gate', async () => {
    await expect(resolveBillingOrgId(asReq({ id: OWNER, organizationId: ORG }), null)).resolves.toBeNull();
    expect(mockResolveActiveOrg).not.toHaveBeenCalled();
  });

  it('returns null when no org is supplied and the caller has no home org', async () => {
    await expect(resolveBillingOrgId(asReq({ id: STRANGER, organizationId: null }), undefined)).resolves.toBeNull();
    expect(mockResolveActiveOrg).not.toHaveBeenCalled();
  });

  it('validates the caller home org through the canonical gate when the request omits one', async () => {
    mockResolveActiveOrg.mockResolvedValue(ORG);
    const req = asReq({ id: OWNER, organizationId: ORG });
    await expect(resolveBillingOrgId(req, undefined)).resolves.toBe(ORG);
    expect(mockResolveActiveOrg).toHaveBeenCalledWith(req, ORG);
  });

  it('validates a client-supplied org through the canonical gate', async () => {
    mockResolveActiveOrg.mockResolvedValue(OTHER_ORG);
    const req = asReq({ id: OWNER, organizationId: ORG });
    await expect(resolveBillingOrgId(req, OTHER_ORG)).resolves.toBe(OTHER_ORG);
    expect(mockResolveActiveOrg).toHaveBeenCalledWith(req, OTHER_ORG);
  });

  it('degrades an implicit own-org fallback to personal (null) when the gate rejects a stale pointer', async () => {
    // A since-revoked member whose organizationId still points at the org did not CHOOSE to bill it,
    // so a stale pointer must fall back to personal billing rather than 403-lock the whole request.
    // Security holds: the org is never billed either way.
    mockResolveActiveOrg.mockRejectedValue(new ForbiddenError('not a member'));
    await expect(resolveBillingOrgId(asReq({ id: STRANGER, organizationId: ORG }), undefined)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('propagates the gate rejection for a CLIENT-SUPPLIED org (the strict trust boundary)', async () => {
    // Unlike the implicit fallback, an org id the caller put in the request body must fail hard when
    // the caller is not a member - it cannot silently degrade to personal and pretend success.
    mockResolveActiveOrg.mockRejectedValue(new ForbiddenError('not a member'));
    await expect(resolveBillingOrgId(asReq({ id: STRANGER, organizationId: ORG }), OTHER_ORG)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('rethrows a non-authorization error from the fallback path (transient DB failure -> 5xx)', async () => {
    mockResolveActiveOrg.mockRejectedValue(new Error('db down'));
    await expect(resolveBillingOrgId(asReq({ id: OWNER, organizationId: ORG }), undefined)).rejects.toThrow('db down');
  });
});
