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
import { resolveActiveOrg } from './resolveActiveOrg';
import type { Request } from 'express';

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
 * Resolve the organization to bill for an AI action from a client-supplied value, rejecting any org
 * the caller is not a member of. This is the trust boundary for the LLM/media routes, which
 * otherwise pass `req.body.organizationId` through to the debit unverified.
 *
 * - `null`       -> personal account (no org billing)
 * - `undefined`  -> the caller's own organization (their `organizationId`), or null if they have none
 * - an org id    -> the client-supplied billing target
 *
 * The resolved org (own-org fallback included) is validated through `resolveActiveOrg` - the ONE
 * place a route turns a client-supplied active org into a trusted scope - so billing authorization
 * can't drift from data-lake scoping (both must use the same shareable ACL gate), and a stale
 * `organizationId` (e.g. a since-revoked member's, before revokeAccess clears it) can't silently
 * keep billing an org the caller no longer belongs to. `resolveActiveOrg` throws ForbiddenError /
 * NotFoundError for a non-member or missing org.
 */
export async function resolveBillingOrgId(
  // Accept any authenticated request shape: the LLM/media routes type `req` with a narrowed `Params`
  // generic that a bare `Request` would reject, and only `req.user` is needed here (and by the gate).
  req: Pick<Request, 'user'>,
  requestedOrgId: string | null | undefined
): Promise<string | null> {
  // Explicit personal (null) carries no cross-tenant risk and skips org billing entirely.
  if (requestedOrgId === null) {
    return null;
  }

  // undefined -> fall back to the caller's own org; anything else is the client-supplied target.
  const orgId = requestedOrgId ?? req.user?.organizationId?.toString() ?? null;
  if (orgId === null) {
    return null;
  }

  // The caller always hands us a full express request (these are authenticated routes); the cast
  // just bridges `Pick<Request, 'user'>` back to the `Request` the shared gate is typed against.
  return (await resolveActiveOrg(req as Request, orgId)) ?? null;
}
