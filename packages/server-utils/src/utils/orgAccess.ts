/**
 * Organization Access Verification Utility
 *
 * Shared utility for verifying user access to organization resources.
 * Used by org-scoped API endpoints (webhooks, GitHub connection, etc.)
 *
 * Administration is gated by NAMED PERMISSION (`verifyOrgPermission`); which role grants which
 * permission is the catalogue in b4m-core/common/src/constants/orgRoles.ts. Membership and status
 * reads have their own tiers. State which one you mean at every call site; picking the wrong one
 * either leaks across a tenant boundary or breaks a members' screen:
 * - `verifyOrgPermission`      - the caller's role grants the named permission (writes and admin reads)
 * - `verifyOrgAdminRead`       - manager-tier status reads, matching `adminUserIds` without the roster row
 * - `verifyOrgMemberOrManager` - any member, or a manager whose row lacks a membership permission (reads only)
 * - `verifyOrgMembership`      - any member (shareable ACL)
 *
 * Security:
 * - Returns NotFoundError for both missing and unauthorized (prevents enumeration)
 * - Admin users have access to all organizations
 */

import { organizationRepository } from '@bike4mind/database/infra';
import { hasOrgPermission, type IUserDocument, type OrgPermission } from '@bike4mind/common';
import { BadRequestError, NotFoundError, UnprocessableEntityError } from '@bike4mind/utils';
import { isValidObjectId } from './objectId';
import { resolveActiveOrg } from './resolveActiveOrg';
import type { Logger } from '@bike4mind/observability';

/**
 * Verify the caller's org role grants `permission`, returning the organization document. The one
 * gate for org administration routes: name the permission the route exercises rather than a role.
 *
 * Non-oracular: a nonexistent org and an org where the caller lacks the permission both answer
 * NotFoundError, so the route cannot be used to enumerate which organization ids exist.
 *
 * @throws BadRequestError if orgId is invalid format
 * @throws NotFoundError if the org doesn't exist or the caller lacks the permission
 */
export async function verifyOrgPermission(
  user: { id: string; isAdmin: boolean },
  orgId: string,
  permission: OrgPermission
) {
  if (!orgId || !isValidObjectId(orgId)) {
    throw new BadRequestError('Invalid organization ID');
  }

  const org = await organizationRepository.findById(orgId);
  if (!org || !hasOrgPermission(user, org, permission)) {
    throw new NotFoundError('Organization not found');
  }

  return org;
}

/**
 * Read-tier sibling of `verifyOrgPermission(..., 'manageContent')` for status surfaces: admits the owner, any `adminUserIds`
 * manager and a platform admin. That is the same set `findIdsWithAdminRights` and
 * `canManageLake` resolve from the user's side, read here off the org document because the org is
 * already in hand: a manager is matched on `adminUserIds` alone, unlike `canAdministerOrganization`
 * (`b4m-core/common/src/constants/organization.ts`), which also requires a current `users[]` row - so
 * a manager whose row has lapsed may still see status but not operate. Never use it to guard a write
 * - `canManage` is the `verifyOrgPermission(..., 'manageContent')` answer, so a caller can render the write controls only for
 * who may use them.
 *
 * Non-oracular like its siblings: a missing org and an unrelated caller both answer NotFoundError.
 */
export async function verifyOrgAdminRead(user: { id: string; isAdmin: boolean }, orgId: string) {
  if (!orgId || !isValidObjectId(orgId)) {
    throw new BadRequestError('Invalid organization ID');
  }

  const org = await organizationRepository.findById(orgId);
  if (!org) {
    throw new NotFoundError('Organization not found');
  }

  const canManage = hasOrgPermission(user, org, 'manageContent');
  const isAppointedAdmin = (org.adminUserIds ?? []).some(adminId => String(adminId) === user.id);
  if (!canManage && !isAppointedAdmin) {
    throw new NotFoundError('Organization not found');
  }

  return { org, canManage };
}

/**
 * Verify the caller BELONGS to the organization, returning the organization document.
 *
 * The membership-level sibling of `verifyOrgPermission`: use this for org-scoped READS a plain member
 * legitimately makes (the org's own subscription plan, say), and `verifyOrgPermission` for anything
 * only a role holder should see or change. Picking the wrong one either leaks across a tenant
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
 * Read-tier sibling of `verifyOrgMembership` that also admits a Team manager whose `users[]` row
 * grants no membership permission (and a platform admin), for status surfaces a manager sees beside the roster they
 * administer, such as the Team's plan. Same answer as `organizationService.get`, so the two cannot
 * disagree about who may open a Team. Never use it to guard a write.
 *
 * The membership lookup runs first, so the common member path stays a single query; the manager
 * fallback costs one more only for callers the shareable ACL rejected. Non-oracular: a missing org
 * and an unrelated caller both answer NotFoundError.
 */
export async function verifyOrgMemberOrManager(user: IUserDocument, orgId: string) {
  if (!orgId || !isValidObjectId(orgId)) {
    throw new BadRequestError('Invalid organization ID');
  }

  const member = await organizationRepository.shareable.findAccessibleById(user, orgId);
  if (member) {
    return member;
  }

  const org = await organizationRepository.findById(orgId);
  if (!org || !hasOrgPermission(user, org, 'manageMembers')) {
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
 * caller out of a route they could always reach. Stale pointers exist in the data (written before
 * `deleteOrganization` cleared them), so validating the fallback
 * through the same gate and catching a non-member/missing rejection matches `chat.ts`: billing is
 * never an automatic consequence of the home-org field. Security holds either way - a non-member
 * org is never billed; the fallback just bills personally instead of failing the request.
 */
export async function resolveBillingOrgId(
  // Structural, not `Request`: the LLM/media routes type `req` with a narrowed `Params` generic, and
  // the augmentation that adds `user`/`logger` lives in apps/client/global.d.ts, outside this package.
  req: { user?: IUserDocument; logger?: Pick<Logger, 'warn'> },
  requestedOrgId: string | null | undefined
): Promise<string | null> {
  // Explicit personal (null) carries no cross-tenant risk and skips org billing entirely.
  if (requestedOrgId === null) {
    return null;
  }

  // A client-supplied target is a hard trust boundary: validate strictly and let a rejection surface.
  if (requestedOrgId !== undefined) {
    return (await resolveActiveOrg(req, requestedOrgId)) ?? null;
  }

  // Implicit own-org fallback: validate, but degrade to personal scope on a stale pointer.
  const ownOrgId = req.user?.organizationId?.toString();
  if (!ownOrgId) {
    return null;
  }
  try {
    return (await resolveActiveOrg(req, ownOrgId)) ?? null;
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

/**
 * Reads the billing org off a public image request body, which accepts `organizationId` and its
 * snake_case alias `organization_id`. Returns the value `resolveBillingOrgId` expects
 * (null = personal, undefined = unspecified). Both keys present with different values is a 422:
 * picking one would silently bill the wrong account.
 */
export function resolveBillingOrgInput(body: {
  organizationId?: string | null;
  organization_id?: string | null;
}): string | null | undefined {
  const { organizationId, organization_id: alias } = body;
  if (organizationId !== undefined && alias !== undefined && organizationId !== alias) {
    throw new UnprocessableEntityError('organizationId and organization_id disagree; send only one');
  }
  return organizationId !== undefined ? organizationId : alias;
}

const ACCEPTED_BILLING_ORG_KEYS = new Set(['organizationId', 'organization_id']);

// Matched against the letters-only lowercase key. No real field of the two image bodies contains
// any of these tokens (pinned by the orgAccess test), so substring matching cannot over-reject.
const BILLING_ORG_KEY_SHAPE = /org|billing|billed|payer/;

/**
 * Reject a body key that is spelled like a billing-org field but is not one of the two accepted
 * names (`organizationID`, `billing_org_id`, `payerOrgId`, `billingAccountId`, ...). The request
 * schemas strip unknown keys, so without this the value would vanish and the request would bill
 * the caller's home org with a 200. Scoped to the public image routes; it is deliberately not a
 * global strict-body policy. Pass the RAW body: the validated one has already lost the key.
 */
export function assertNoStrayBillingOrgKeys(rawBody: unknown): void {
  if (!rawBody || typeof rawBody !== 'object') return;
  for (const key of Object.keys(rawBody)) {
    if (ACCEPTED_BILLING_ORG_KEYS.has(key)) continue;
    if (BILLING_ORG_KEY_SHAPE.test(key.toLowerCase().replace(/[^a-z]/g, ''))) {
      throw new UnprocessableEntityError(
        `Unknown field "${key}"; send the billing org as organizationId or organization_id`
      );
    }
  }
}
