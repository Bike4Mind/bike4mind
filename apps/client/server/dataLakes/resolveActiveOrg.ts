import { ForbiddenError, NotFoundError } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';
import type { Request } from 'express';

/**
 * Resolves the org a data-lake write (create / visibility promotion) should be scoped to
 * from the caller's active account-switcher selection - the org id the client sends with
 * the request - and AUTHORIZATION-VALIDATES it before it can be trusted.
 *
 * The active org is client-supplied, so it can never be trusted blindly: a caller must not
 * be able to scope a lake into an org they don't belong to (that would plant a lake in
 * another org's namespace - the exact hole the old `never from the body` rule guarded).
 * We confirm membership via the same share-access gate the org read path uses
 * (`shareable.findAccessibleById`, as `organizationService.get` does); admins pass through
 * since the gates already grant them access to every org.
 *
 * Returns the validated org id when the caller supplied one they belong to, or `undefined`
 * when none was supplied (personal scope - the default). Throws `ForbiddenError` when a
 * caller supplies an org they have no access to, or `NotFoundError` when the org doesn't
 * exist. Both paths fail closed on a non-existent org, so a typo can never stamp a lake
 * with a garbage `organizationId`.
 *
 * This is the ONE place a data-lake route turns a client-supplied active org into a trusted
 * scope, so the create and visibility endpoints can't drift in how they validate it.
 */
export async function resolveActiveOrg(
  req: Request,
  requestedOrgId: string | undefined | null
): Promise<string | undefined> {
  const orgId = requestedOrgId?.trim();
  if (!orgId) return undefined; // no active org selected → personal scope

  // Admins can scope to any org, but the org must still exist - otherwise a typo in an admin
  // flow would stamp the lake with a garbage organizationId. A membership read would wrongly
  // reject an admin acting on behalf of an org, so verify existence instead.
  if (req.user.isAdmin) {
    let org;
    try {
      org = await organizationRepository.findById(orgId);
    } catch (err) {
      // A malformed org id casts to a Mongoose CastError - treat that as "no such org" and
      // fail closed. Any other error is a transient DB failure that must surface as a 5xx,
      // not masquerade as a missing org.
      if ((err as { name?: string })?.name !== 'CastError') throw err;
      org = null;
    }
    if (!org) {
      throw new NotFoundError('Organization not found.');
    }
    return orgId;
  }

  // Non-admins: the share-access gate grants only orgs they belong to and returns null for a
  // non-existent org, so this both authorizes and fails closed on a bad id.
  const org = await organizationRepository.shareable.findAccessibleById(req.user, orgId);
  if (!org) {
    throw new ForbiddenError('You are not a member of the selected organization.');
  }
  return orgId;
}
