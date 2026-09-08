import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

const mockFindById = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
}));

import { verifyOrgAccess, assertOrgBillingAccess, resolveBillingOrgId } from '../orgAccess';

// Valid 24-hex ObjectId strings (pass Types.ObjectId round-trip validation).
const ORG = '650000000000000000000abc';
const OWNER = '650000000000000000000111';
const MANAGER = '650000000000000000000222';
const STRANGER = '650000000000000000000333';
const MEMBER = '650000000000000000000444';
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

// `users[]` is the authoritative membership ACL (see OrganizationModel schema comment).
const orgWithMember = { id: ORG, userId: OWNER, managerId: MANAGER, users: [{ userId: MEMBER }] };

describe('assertOrgBillingAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(orgWithMember);
  });

  it('rejects an invalid ObjectId without touching the DB', async () => {
    await expect(assertOrgBillingAccess({ id: OWNER, isAdmin: false }, 'nope')).rejects.toBeInstanceOf(BadRequestError);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('grants a plain member (via users[]), unlike verifyOrgAccess', async () => {
    const result = await assertOrgBillingAccess({ id: MEMBER, isAdmin: false }, ORG);
    expect(result).toBe(orgWithMember);
  });

  it('grants owner and manager', async () => {
    await expect(assertOrgBillingAccess({ id: OWNER, isAdmin: false }, ORG)).resolves.toBe(orgWithMember);
    await expect(assertOrgBillingAccess({ id: MANAGER, isAdmin: false }, ORG)).resolves.toBe(orgWithMember);
  });

  it('404s a non-member (same error as missing, to prevent enumeration)', async () => {
    await expect(assertOrgBillingAccess({ id: STRANGER, isAdmin: false }, ORG)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('404s when the org does not exist', async () => {
    mockFindById.mockResolvedValue(null);
    await expect(assertOrgBillingAccess({ id: MEMBER, isAdmin: false }, ORG)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('resolveBillingOrgId', () => {
  const user = { id: MEMBER, isAdmin: false, organizationId: ORG };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(orgWithMember);
  });

  it('returns the caller own org when the request omits an org (undefined), without a DB check', async () => {
    await expect(resolveBillingOrgId(user, undefined)).resolves.toBe(ORG);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('returns null (personal) when the request explicitly passes null, without a DB check', async () => {
    await expect(resolveBillingOrgId(user, null)).resolves.toBeNull();
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('short-circuits the caller own org id without a membership DB read', async () => {
    await expect(resolveBillingOrgId(user, ORG)).resolves.toBe(ORG);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('verifies membership for any other client-supplied org, rejecting a non-member', async () => {
    // stranger tries to bill an org they do not belong to
    const stranger = { id: STRANGER, isAdmin: false, organizationId: null };
    await expect(resolveBillingOrgId(stranger, OTHER_ORG)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockFindById).toHaveBeenCalledWith(OTHER_ORG);
  });

  it('allows a valid member to bill an org other than their own after a membership check', async () => {
    const user2 = { id: MEMBER, isAdmin: false, organizationId: null };
    await expect(resolveBillingOrgId(user2, ORG)).resolves.toBe(ORG);
    expect(mockFindById).toHaveBeenCalledWith(ORG);
  });
});
