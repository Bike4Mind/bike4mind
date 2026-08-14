import type { IUserDocument } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';

/**
 * Minimal structural request shape for the membership memo - the same pattern (and the same
 * cross-package-compilability reason) as `EntitlementRequest`; see the comment there.
 */
export interface MembershipRequest {
  user?: IUserDocument;
  membershipOrgIds?: string[];
}

/**
 * The caller's authoritative org-membership set (owner + users[] ACL - see
 * `organizationRepository.findMembershipOrgIds`, #1674), memoized per request the same way
 * `getRequestEntitlements` memoizes entitlement keys: resolved lazily on first use, cached on
 * `req.membershipOrgIds` so every later gate within the same request reuses the result.
 *
 * `??=` is correct here: an empty membership list is a valid, non-nullish result that must
 * memoize (`||=` would re-query on every org-less user's request).
 */
export async function getRequestMembershipOrgIds(req: MembershipRequest): Promise<string[]> {
  // Fail closed: a nullish user belongs to nothing.
  if (!req.user) return [];
  return (req.membershipOrgIds ??= await organizationRepository.findMembershipOrgIds(req.user.id));
}
