/**
 * Organization Access Verification Utility
 *
 * Shared utility for verifying user access to organization resources.
 * Used by org-scoped API endpoints (webhooks, GitHub connection, etc.)
 *
 * Security:
 * - Returns NotFoundError for both missing and unauthorized (prevents enumeration)
 * - Admin users have access to all organizations
 * - Non-admin users must be owner or manager
 */

import { organizationRepository } from '@bike4mind/database/infra';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { isValidObjectId } from '@server/utils/objectId';
import { IUserDocument } from '@bike4mind/common';

/**
 * Verify user has update access to the organization
 *
 * @param user - The authenticated user
 * @param orgId - The organization ID to verify access for
 * @returns The organization document if access is granted
 * @throws BadRequestError if orgId is invalid format
 * @throws NotFoundError if org doesn't exist or user doesn't have access
 */
export async function verifyOrgAccess(user: { id: string; isAdmin: boolean }, orgId: string) {
  // P1: Validate orgId format to prevent invalid database queries
  if (!orgId || !isValidObjectId(orgId)) {
    throw new BadRequestError('Invalid organization ID');
  }

  // Admin users have access to all organizations
  if (user.isAdmin) {
    const org = await organizationRepository.findById(orgId);
    if (!org) {
      throw new NotFoundError('Organization not found');
    }
    return org;
  }

  // For non-admin users, check if they are owner or manager
  const org = await organizationRepository.findById(orgId);
  if (!org) {
    throw new NotFoundError('Organization not found');
  }

  // Check if user is owner or manager (has update access)
  const isOwner = org.userId === user.id;
  const isManager = org.managerId === user.id;

  if (!isOwner && !isManager) {
    // Return same error for not found and not authorized (prevent enumeration)
    throw new NotFoundError('Organization not found');
  }

  return org;
}

/**
 * Verify the user may bill an organization's credit pool.
 *
 * Broader than `verifyOrgAccess` (owner/manager/admin only): any member may spend
 * the org's credits, so this also accepts membership via the authoritative `users[]`
 * ACL (see the OrganizationModel schema comment - `users[]` is the membership source
 * of truth; `userDetails[]` is only a per-member credit side-table). Returns the same
 * NotFoundError for missing and unauthorized orgs to prevent enumeration.
 *
 * @throws BadRequestError if orgId is malformed
 * @throws NotFoundError if the org does not exist or the caller is not a member
 */
export async function assertOrgBillingAccess(user: { id: string; isAdmin: boolean }, orgId: string) {
  if (!orgId || !isValidObjectId(orgId)) {
    throw new BadRequestError('Invalid organization ID');
  }

  const org = await organizationRepository.findById(orgId);
  if (!org) {
    throw new NotFoundError('Organization not found');
  }

  if (user.isAdmin) {
    return org;
  }

  const isOwner = org.userId === user.id;
  const isManager = org.managerId === user.id;
  const isMember = org.users?.some(u => u.userId === user.id) ?? false;

  if (!isOwner && !isManager && !isMember) {
    throw new NotFoundError('Organization not found');
  }

  return org;
}

/**
 * Resolve the organization to bill for an AI action from a client-supplied value,
 * rejecting any org the caller is not a member of. This is the trust boundary for
 * the LLM/media routes, which otherwise pass `req.body.organizationId` through to the
 * debit unverified.
 *
 * - `undefined`  -> the caller's own organization (their `organizationId`, trusted), or null
 * - `null`       -> personal account (no org billing)
 * - an org id    -> billed only if it is the caller's own org or one they are a member of;
 *                   a non-member gets NotFoundError (see `assertOrgBillingAccess`)
 */
export async function resolveBillingOrgId(
  user: Pick<IUserDocument, 'id' | 'isAdmin' | 'organizationId'>,
  requestedOrgId: string | null | undefined
): Promise<string | null> {
  const ownOrgId = user.organizationId?.toString() ?? null;

  if (requestedOrgId === undefined) {
    return ownOrgId;
  }
  // personal (null) or the caller's own org carry no cross-tenant risk
  if (requestedOrgId === null || requestedOrgId === ownOrgId) {
    return requestedOrgId;
  }

  await assertOrgBillingAccess(user, requestedOrgId);
  return requestedOrgId;
}
