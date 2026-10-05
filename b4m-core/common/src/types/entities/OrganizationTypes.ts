import { IAppFileDocument, IShareableDocument, IShareableStaticMethods } from '.';
import { IBaseRepository } from './BaseTypes';
import { ICreditHolder, ICreditHolderMethods } from './CreditHolderTypes';
import { IModelConfig } from './ModelConfigTypes';

export interface IUserDetails {
  id: string;
  email?: string;
  name: string;
  /** Credits spent in the period starting at `periodStart`. */
  usedCredits: number;
  lastCreditUsedAt: Date | null;
  /** Start of the UTC calendar month `usedCredits` belongs to; missing or older reads as 0 spent. */
  periodStart?: Date | null;
  /** Per-member monthly cap overriding the org's `maxCreditsPerMember`; null/absent inherits it. */
  maxCredits?: number | null;
}

export interface IOrganization extends ICreditHolder, IModelConfig {
  name: string;
  personal: boolean; // True if this is a personal organization

  /**
   * Group-type keys (GROUP_TYPE_CATALOG) this org is allowed to have. Platform-admin writes
   * only; defaults to empty = fail-closed. An org starts with no group types (org-groups #1172).
   */
  allowedGroupTypes: string[];
  /**
   * User ids appointed as org admins by the billing owner or a platform admin. NOT a `Permission`
   * verb and NOT on the shared `users[]` ACL. The billing owner (`userId`) is implicitly an admin
   * and need not appear here.
   */
  adminUserIds: string[];
  description: string;
  billingContact: string;
  seats: number;
  /**
   * The user ID of the owner of the organization
   */
  userId: string;
  /**
   * The user ID of the team manager (optional, separate from billing owner)
   */
  managerId?: string | null;
  userDetails: Array<IUserDetails> | null;
  logoFileId?: string | null; // File ID of the organization's logo

  /** Virtual field to the organization's logo (AppFile) */
  logo?: IAppFileDocument | null;
  stripeCustomerId?: string | null;

  storageLimit?: number /** Storage limit in MBs */;

  /**
   * Organization-wide system prompt that applies to all conversations for team members.
   * This allows enterprise customers to set domain-specific context that overrides
   * model training biases (e.g., Lift Port focusing on lunar space elevators).
   */
  systemPrompt?: string;

  /**
   * Optional default monthly per-member credit budget. When set, a member cannot spend more
   * than this many credits from the org pool per UTC calendar month, unless their
   * `userDetails[].maxCredits` override says otherwise. Observability-only if unset.
   * Known TOCTOU: pre-check and atomic increment are separate operations;
   * concurrent requests can exceed the limit by one. Accepted: window is tiny, stakes are low.
   */
  maxCreditsPerMember?: number | null;
}
export interface IOrganizationDocument extends IOrganization, IShareableDocument {}

/**
 * Who counts as a member for org-scoped reporting over user-authored content, and where the two
 * populations that answer that question disagree.
 *
 * The org ACL - billing owner plus `users[]` rows granting read/write, the predicate behind
 * `findMembershipOrgIds` - is who the ORG says its members are. The stamp population is who
 * org-stamped content actually names: `Feedback.organizationId` is copied from the author's own
 * `User.organizationId` pointer at write time, never from `users[]`. A manager listed only in
 * `managerId`, an appointed org admin, or a seat whose ACL row lags therefore authors org-stamped
 * rows while matching no ACL row, and an ACL-derived `$in` drops those rows with nothing to show
 * for it. Callers scope on the union and surface the two one-sided lists rather than quietly
 * picking a population.
 */
export interface OrgMemberPopulation {
  /** Both populations unioned and deduplicated. Suitable for an `$in` filter. */
  userIds: string[];
  /** In the org's ACL, but with no `User.organizationId` pointing at this org. */
  aclOnly: string[];
  /** Pointed at this org by `User.organizationId`, but absent from the org's ACL. */
  stampOnly: string[];
}

export interface IOrganizationRepository extends IBaseRepository<IOrganizationDocument>, ICreditHolderMethods {
  shareable: IShareableStaticMethods<IOrganizationDocument>;

  /**
   * Search for organizations with filtering, sorting, and pagination
   *
   * @param query - Search query
   * @param filters - Filters for the search
   * @param pagination - Pagination options
   * @param orderBy - Sorting options
   */
  search: (
    query: string,
    filters: { personal?: boolean; name?: string; userId?: string },
    pagination: { page: number; limit: number },
    orderBy: { field: keyof IOrganizationDocument; direction: 'asc' | 'desc' }
  ) => Promise<{
    data: IOrganizationDocument[];
    hasMore: boolean;
    total: number;
  }>;
  /**
   * Find an organization by its Stripe customer ID
   *
   * @param stripeCustomerId - Stripe customer ID
   * @returns Organization document or null if not found
   */
  findByStripeCustomerId(stripeCustomerId: string): Promise<IOrganizationDocument | null>;

  /**
   * Atomically add a member and raise the seat ceiling to fit, in a single update (#1239).
   * Race-safe: idempotent on a duplicate add, and raises `seats` only to the post-add owner-inclusive
   * team size (owner + members, #1423; never a double-raise). The raise is clamped so that size stays
   * <= `ORGANIZATION_SUBSCRIPTION_MAX_SEATS` (#1424), so
   * a full org matches no doc and returns null - the caller routes that to 'at-capacity' rather than
   * growing a seat floor no `setSeats` value can satisfy. Returns the PRE-image (before/after seats are
   * derived from it), or null if the user is already a member, the org is gone, OR the org is at the
   * ceiling. Domain-signup auto-add path for orgs NOT billed through Stripe - it does not sync Stripe's
   * billed quantity (see `addMemberIfUnderCeiling`).
   */
  addMemberRaisingSeats(
    organizationId: string,
    member: IOrganizationDocument['users'][number]
  ): Promise<IOrganizationDocument | null>;

  /**
   * Atomically add a member only if it fits under the current seat ceiling, never raising it - the
   * domain-signup auto-add path for Stripe-billed orgs (#1239), where an out-of-band raise would
   * desync Stripe's billed quantity. Returns the PRE-image, or null if the user is already a member,
   * the org is gone, OR the org is at capacity (the caller re-reads to distinguish those).
   */
  addMemberIfUnderCeiling(
    organizationId: string,
    member: IOrganizationDocument['users'][number]
  ): Promise<IOrganizationDocument | null>;

  /**
   * IDs of every organization the user administers (billing owner or manager).
   *
   * @param userId - The user ID
   * @returns Bare list of organization IDs, suitable for an `$in` filter
   */
  findIdsAdministeredBy(userId: string): Promise<string[]>;

  /**
   * IDs of every organization the user is a MEMBER of: the org's owner (`userId`) or a
   * `users[]` ACL row with read/write permission - the same membership arms
   * `shareable.findAllAccessible` grants on (groups deliberately excluded: org membership
   * is direct). Normalized strings, suitable for an `$in` filter. This is the authoritative
   * set lake authorization consumes (see AccessContext.organizationIds, #1674) - NOT
   * `user.organizationId`, which is a display preference.
   */
  findMembershipOrgIds(userId: string): Promise<string[]>;

  /**
   * Every user id whose org-stamped content belongs in this org's reports, plus the disagreement
   * between the two populations that define "belongs". See `OrgMemberPopulation`.
   */
  findMemberUserIds(organizationId: string): Promise<OrgMemberPopulation>;

  /**
   * IDs of every organization where the user holds admin RIGHTS: billing owner (`userId`), team
   * manager (`managerId`), OR an appointed org admin (`adminUserIds`). Broader than
   * `findIdsAdministeredBy` (which omits appointed admins) - deliberately a separate method so its
   * existing consumers keep their narrower semantics. This is the org-admin set data-lake management
   * consults: an org admin may manage any lake scoped to that org (see `canManageLake`). Returns a
   * bare id list, suitable for an `$in` filter or membership test.
   */
  findIdsWithAdminRights(userId: string): Promise<string[]>;

  /**
   * Find an organization by its ID and user ID
   * @param id - The ID of the organization
   * @param userId - The ID of the user
   * @returns The organization document or null if not found
   */
  findByIdAndUserId(id: string, userId: string): Promise<IOrganizationDocument | null>;

  /**
   * Seed a zero-usage `userDetails` row for a member if absent (idempotent). Must be called wherever
   * membership is granted so `userDetails[]` stays in sync with `users[]`: `updateUserDetails` uses a
   * positional update that cannot create the row it positions on, so a member with no row tracks no
   * usage and escapes `maxCreditsPerMember` entirely.
   *
   * @param organizationId - The ID of the organization
   * @param member - The member identity to seed (id + email/name for the row's display fields)
   */
  ensureUserDetails(organizationId: string, member: { id: string; email: string; name: string }): Promise<void>;

  /** Remove a member from users/userDetails/adminUserIds and vacate managerId if theirs (one targeted, idempotent update). */
  removeMember(organizationId: string, userId: string): Promise<void>;

  /**
   * Set one member's monthly credit budget override (`userDetails[].maxCredits`; null inherits the
   * org default). Targeted positional `$set`; returns false when the member has no row to update.
   */
  setMemberMaxCredits(organizationId: string, userId: string, maxCredits: number | null): Promise<boolean>;

  /**
   * Record spend against a member's monthly budget within an organization, atomically resetting
   * the row first when its `periodStart` belongs to an earlier month.
   * The caller must ensure the row exists first (see `ensureUserDetails`); the positional update
   * cannot create a missing row and no-ops if one is absent.
   *
   * @param organizationId - The ID of the organization
   * @param userId - The ID of the user within the organization
   * @param updates - creditsDelta is added to the current period's usage; lastCreditUsedAt is set
   * @param now - clock for the period boundary (defaults to the current time)
   */
  updateUserDetails(
    organizationId: string,
    userId: string,
    updates: { creditsDelta?: number; lastCreditUsedAt?: Date },
    now?: Date
  ): Promise<void>;
}
