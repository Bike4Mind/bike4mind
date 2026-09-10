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
 * A client-supplied org id is validated strictly through `resolveActiveOrg` - the ONE place a
 * route turns a client-supplied active org into a trusted scope - so billing authorization can't
 * drift from data-lake scoping (both must use the same shareable ACL gate); its ForbiddenError /
 * NotFoundError propagates, because the caller explicitly asked to bill that org and may not.
 *
 * The IMPLICIT own-org fallback (`undefined` request) is different: the caller did not choose it,
 * so a stale `organizationId` pointer must degrade to personal scope rather than 403-lock the
 * caller out of a route they could always reach. Stale pointers already exist in the data (revoke,
 * `deleteOrganization`, and `assignManager` paths leave them), so validating the fallback through
 * the same gate and catching a non-member/missing rejection matches `chat.ts`: billing is never an
 * automatic consequence of the home-org field. Security holds either way - a non-member org is
 * never billed; the fallback just bills personally instead of failing the request.
 */
export async function resolveBillingOrgId(
  // Accept any authenticated request shape: the LLM/media routes type `req` with a narrowed `Params`
  // generic that a bare `Request` would reject, and only `req.user`/`req.logger` are needed here.
  req: Pick<Request, 'user' | 'logger'>,
  requestedOrgId: string | null | undefined
): Promise<string | null> {
  // Explicit personal (null) carries no cross-tenant risk and skips org billing entirely.
  if (requestedOrgId === null) {
    return null;
  }

  // The caller always hands us a full express request (these are authenticated routes); the cast
  // just bridges `Pick<Request, ...>` back to the `Request` the shared gate is typed against.
  const reqAsExpress = req as Request;

  // A client-supplied target is a hard trust boundary: validate strictly and let a rejection surface.
  if (requestedOrgId !== undefined) {
    return (await resolveActiveOrg(reqAsExpress, requestedOrgId)) ?? null;
  }

  // Implicit own-org fallback: validate, but degrade to personal scope on a stale pointer.
  const ownOrgId = req.user?.organizationId?.toString();
  if (!ownOrgId) {
    return null;
  }
  try {
    return (await resolveActiveOrg(reqAsExpress, ownOrgId)) ?? null;
  } catch (err) {
    // Match by name, not instanceof: resolveActiveOrg throws @bike4mind/common's error classes,
    // which are not identity-equal to this file's @bike4mind/utils imports.
    const name = (err as { name?: string })?.name;
    if (name === 'ForbiddenError' || name === 'NotFoundError') {
      req.logger?.warn(
        `resolveBillingOrgId: stale home-org pointer for user ${req.user?.id ?? 'unknown'} -> personal billing scope (${name})`
      );
      return null;
    }
    throw err; // a transient DB failure must surface as a 5xx, not silently bill personally
  }
}
