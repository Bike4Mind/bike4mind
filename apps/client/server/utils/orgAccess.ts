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
import type { IUserDocument } from '@bike4mind/common';
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
 * Verify the caller OWNS the organization, returning the organization document.
 *
 * The strictest of the three tiers in this file - owner only, where `verifyOrgAccess` also admits
 * the manager and `verifyOrgMembership` admits any member. Reserved for billing writes, where the
 * caller is committing the org to a charge or changing what it pays: the org's billing owner is the
 * only party who has agreed to that, and a manager has not.
 *
 * Non-oracular, like its siblings: a nonexistent org and an org the caller does not own both answer
 * NotFoundError, so the route cannot be used to enumerate which organization ids exist.
 *
 * Two routes still spell the same bar out inline: `subscriptions/update-seats.ts` and
 * `stripe/portal.ts`. Both answer ForbiddenError / BadRequestError after an unconditional lookup,
 * so unlike this helper they do leak which org ids exist. Left alone here only because changing
 * the status they return is a visible API change; if you touch either, move it onto this helper
 * rather than copying the inline form again.
 */
export async function verifyOrgOwner(user: { id: string; isAdmin: boolean }, orgId: string) {
  if (!orgId || !isValidObjectId(orgId)) {
    throw new BadRequestError('Invalid organization ID');
  }

  const org = await organizationRepository.findById(orgId);
  if (!org) {
    throw new NotFoundError('Organization not found');
  }

  // Platform admins pass through, matching every other gate in this file.
  if (!user.isAdmin && org.userId !== user.id) {
    throw new NotFoundError('Organization not found');
  }

  return org;
}

/**
 * Verify the caller BELONGS to the organization, returning the organization document.
 *
 * The membership-level sibling of `verifyOrgAccess`: use this for org-scoped READS a plain member
 * legitimately makes (the org's own subscription plan, say), and `verifyOrgAccess` for anything
 * only an owner/manager should see or change. Picking the wrong one either leaks across a tenant
 * boundary or breaks a members' screen, so state which you mean at every call site.
 *
 * Deliberately non-oracular: `findAccessibleById` returns null for BOTH a nonexistent org and one
 * the caller has no access to, and both collapse to the same NotFoundError, so this route cannot be
 * used to enumerate which organization ids exist.
 *
 * Uses the shareable ACL (owner + `users[]` + the groups arm), matching `resolveActiveOrg` rather
 * than the narrower `findMembershipOrgIds`; a read gate must not be stricter than the write-target
 * validator or a member loses sight of an org they can already act as.
 */
// Takes the whole user rather than the `id`/`groups`/`isAdmin` slice it actually reads: the
// shareable ACL is declared as `findAccessibleById(user: IUserDocument, id)`, so narrowing here
// would only move the lie to a cast at that call site. Callers pass `req.user`.
export async function verifyOrgMembership(user: IUserDocument, orgId: string) {
  if (!orgId || !isValidObjectId(orgId)) {
    throw new BadRequestError('Invalid organization ID');
  }

  // Admins already reach every org through the gates below them; verify existence only.
  if (user.isAdmin) {
    const org = await organizationRepository.findById(orgId);
    if (!org) {
      throw new NotFoundError('Organization not found');
    }
    return org;
  }

  const org = await organizationRepository.shareable.findAccessibleById(user, orgId);
  if (!org) {
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
 * caller out of a route they could always reach. Stale pointers already exist in the data (the
 * `deleteOrganization` and `assignManager` paths leave them), so validating the fallback through
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
