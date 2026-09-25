import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/common';
import type { IUserDocument } from '@bike4mind/common';

const mockFindById = vi.fn();
const mockFindAccessibleById = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
    shareable: { findAccessibleById: (...a: unknown[]) => mockFindAccessibleById(...a) },
  },
}));

// resolveBillingOrgId delegates the membership decision to the canonical org gate; mock it so this
// suite verifies only the tri-state routing and that the gate is consulted (the gate itself has its
// own tests in resolveActiveOrg.test.ts).
const mockResolveActiveOrg = vi.fn();
vi.mock('../resolveActiveOrg', () => ({
  resolveActiveOrg: (...a: unknown[]) => mockResolveActiveOrg(...a),
}));

import { verifyOrgAccess, verifyOrgOwner, verifyOrgMembership, resolveBillingOrgId } from '../orgAccess';

// Valid 24-hex ObjectId strings (pass Types.ObjectId round-trip validation).
const ORG = '650000000000000000000abc';
const OWNER = '650000000000000000000111';
const MANAGER = '650000000000000000000222';
const STRANGER = '650000000000000000000333';
const OTHER_ORG = '650000000000000000000def';

const org = { id: ORG, userId: OWNER, managerId: MANAGER };

// verifyOrgMembership takes a full IUserDocument because the shareable ACL it delegates to is
// declared that way; only id/groups/isAdmin are ever read, so the fixtures supply those and cast.
const asUser = (u: { id: string; groups: string[]; isAdmin: boolean }) => u as unknown as IUserDocument;

describe('verifyOrgOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(org);
  });

  // Both arms of `!orgId || !isValidObjectId(orgId)`. The falsy arm is not theoretical: the Slack
  // routes source the id from `req.query.id`, which is `string | undefined` on a shape Next.js
  // will happily route, so the helper has to answer it rather than query on undefined.
  it.each([
    { orgId: 'not-an-object-id', why: 'malformed string' },
    { orgId: '', why: 'empty string' },
    { orgId: undefined as unknown as string, why: 'absent, as req.query.id can be' },
  ])('rejects an invalid org id without touching the DB: $why', async ({ orgId }) => {
    await expect(verifyOrgOwner({ id: OWNER, isAdmin: false }, orgId)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('grants the org owner', async () => {
    const result = await verifyOrgOwner({ id: OWNER, isAdmin: false }, ORG);
    expect(result).toBe(org);
  });

  it('grants an admin any org', async () => {
    const result = await verifyOrgOwner({ id: STRANGER, isAdmin: true }, ORG);
    expect(result).toBe(org);
  });

  // The tier boundary, and the only assertion that distinguishes this gate from verifyOrgAccess:
  // the manager passes there and must not pass here. Deleting the owner check would leave every
  // other test in this block green.
  it('404s the team manager, who passes verifyOrgAccess but does not own the billing', async () => {
    await expect(verifyOrgOwner({ id: MANAGER, isAdmin: false }, ORG)).rejects.toBeInstanceOf(NotFoundError);
    await expect(verifyOrgAccess({ id: MANAGER, isAdmin: false }, ORG)).resolves.toBe(org);
  });

  it('404s a non-owner (same error as missing, to prevent enumeration)', async () => {
    await expect(verifyOrgOwner({ id: STRANGER, isAdmin: false }, ORG)).rejects.toBeInstanceOf(NotFoundError);
  });

  // Non-oracular: an outsider must not be able to tell "org exists, not yours" from "no such org".
  it('answers a missing org with the same error a non-owner gets', async () => {
    mockFindById.mockResolvedValue(null);
    const missing = await verifyOrgOwner({ id: STRANGER, isAdmin: false }, OTHER_ORG).catch(e => e);

    mockFindById.mockResolvedValue(org);
    const forbidden = await verifyOrgOwner({ id: STRANGER, isAdmin: false }, ORG).catch(e => e);

    expect(missing.constructor).toBe(forbidden.constructor);
    expect(missing.message).toBe(forbidden.message);
    expect(missing.statusCode).toBe(forbidden.statusCode);
  });

  it('404s an admin when the org does not exist', async () => {
    mockFindById.mockResolvedValue(null);
    await expect(verifyOrgOwner({ id: STRANGER, isAdmin: true }, ORG)).rejects.toBeInstanceOf(NotFoundError);
  });
});

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

/**
 * The membership-level sibling of verifyOrgAccess, for org-scoped reads a plain member legitimately
 * makes (their org's subscription plan). Its whole job is to be WIDER than verifyOrgAccess on the
 * member arm while staying non-oracular for everyone else.
 */
describe('verifyOrgMembership', () => {
  const member = asUser({ id: STRANGER, groups: [], isAdmin: false });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(org);
    mockFindAccessibleById.mockResolvedValue(org);
  });

  it('rejects an invalid ObjectId without touching the DB', async () => {
    await expect(verifyOrgMembership(member, 'not-an-object-id')).rejects.toBeInstanceOf(BadRequestError);
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('grants a plain member, who verifyOrgAccess would refuse', async () => {
    await expect(verifyOrgMembership(member, ORG)).resolves.toBe(org);
    await expect(verifyOrgAccess({ id: STRANGER, isAdmin: false }, ORG)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('consults the shareable ACL for a non-admin, not a bare findById', async () => {
    await verifyOrgMembership(member, ORG);
    expect(mockFindAccessibleById).toHaveBeenCalledWith(member, ORG);
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('404s a non-member', async () => {
    mockFindAccessibleById.mockResolvedValue(null);
    await expect(verifyOrgMembership(member, ORG)).rejects.toBeInstanceOf(NotFoundError);
  });

  // The anti-enumeration property: a caller must not be able to tell an org they cannot see from
  // one that does not exist.
  it('404s a missing org identically to an inaccessible one', async () => {
    mockFindAccessibleById.mockResolvedValue(null);
    const inaccessible = await verifyOrgMembership(member, ORG).catch((e: Error) => e);
    mockFindAccessibleById.mockResolvedValue(null);
    const missing = await verifyOrgMembership(member, OTHER_ORG).catch((e: Error) => e);

    expect((inaccessible as Error).constructor).toBe((missing as Error).constructor);
    expect((inaccessible as Error).message).toBe((missing as Error).message);
  });

  it('grants an admin any org, verifying existence only', async () => {
    await expect(verifyOrgMembership(asUser({ id: STRANGER, groups: [], isAdmin: true }), ORG)).resolves.toBe(org);
    expect(mockFindById).toHaveBeenCalledWith(ORG);
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
  });

  it('404s an admin when the org does not exist', async () => {
    mockFindById.mockResolvedValue(null);
    await expect(verifyOrgMembership(asUser({ id: STRANGER, groups: [], isAdmin: true }), ORG)).rejects.toBeInstanceOf(
      NotFoundError
    );
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
