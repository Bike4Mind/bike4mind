/**
 * Organization seat-limit policy - the floor and ceiling every seat change is bound by.
 *
 * Lives in common (not the app's subscriptions constants) because the ceiling has to be
 * enforced in the persistence layer too: `OrganizationModel.addMemberRaisingSeats` clamps
 * the auto-raise against MAX, and packages/database cannot import from apps/client. The app
 * re-exports these from `lib/subscriptions/constants` so existing importers stay unchanged.
 */

/** Paid-plan minimum seats (Stripe path). Admin grants may go smaller (see ADMIN_MIN_SEATS). */
export const ORGANIZATION_SUBSCRIPTION_MIN_SEATS = 4;

/**
 * Hard, owner-inclusive ceiling on org seats (owner + members + pending, #1423). Both
 * `validateSeatChange` and the unattended partner-rule auto-raise (`addMemberRaisingSeats`) clamp to
 * this, so a full org falls through to the at-capacity path instead of growing a seat floor that no
 * `setSeats` value can satisfy (#1424).
 */
export const ORGANIZATION_SUBSCRIPTION_MAX_SEATS = 100;

/**
 * The org `users[]` ACL permission values that CONSTITUTE membership - the single definition every
 * "is X a member of this org" answer derives from.
 *
 * Lives in common because the same set has to be applied in three layers that cannot import each
 * other: the persistence gate (`OrganizationModel`'s `findMembershipOrgIds` / `search`, which is
 * what actually admits a reader), the engine's derived counts (`assembleLakeAccessView`'s org-channel
 * `holderCount`), and anything app-side that has to agree with both. A hand-kept second copy is how a
 * compliance surface ends up reporting a member total larger than the set the gate admits.
 *
 * 'write' implies membership even where 'read' was never explicitly granted: every app write path
 * persists ['read'], so a write-only row can only come from legacy/out-of-band data, and the gate has
 * always treated it as a member. 'write' is deliberately NOT a `Permission` enum member - adding it
 * would widen the share/invite contracts and break the exhaustive `Record<Permission, string>` maps
 * in the client.
 */
export const ORG_MEMBERSHIP_ACL_PERMISSIONS = ['read', 'write'] as const;
