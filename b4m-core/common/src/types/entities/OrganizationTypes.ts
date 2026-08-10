import { IAppFileDocument, IShareableDocument, IShareableStaticMethods } from '.';
import { IBaseRepository } from './BaseTypes';
import { ICreditHolder, ICreditHolderMethods } from './CreditHolderTypes';
import { IModelConfig } from './ModelConfigTypes';

export interface IUserDetails {
  id: string;
  email?: string;
  name: string;
  usedCredits: number;
  lastCreditUsedAt: Date | null;
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
  currentStorageSize?: number /** Current storage size in Bytes */;

  /**
   * Organization-wide system prompt that applies to all conversations for team members.
   * This allows enterprise customers to set domain-specific context that overrides
   * model training biases (e.g., Lift Port focusing on lunar space elevators).
   */
  systemPrompt?: string;

  /**
   * Optional per-member credit spending cap. When set, members cannot spend more than
   * this many credits from the org pool. Observability-only if unset (no limit enforced).
   * Known TOCTOU: pre-check and atomic increment are separate operations;
   * concurrent requests can exceed the limit by one. Accepted: window is tiny, stakes are low.
   */
  maxCreditsPerMember?: number | null;
}
export interface IOrganizationDocument extends IOrganization, IShareableDocument {}

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
   * Race-safe: idempotent on a duplicate add, and raises `seats` only to the post-add member count
   * (never a double-raise). The raise is clamped at `ORGANIZATION_SUBSCRIPTION_MAX_SEATS` (#1424), so
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
   * Find an organization by its ID and user ID
   * @param id - The ID of the organization
   * @param userId - The ID of the user
   * @returns The organization document or null if not found
   */
  findByIdAndUserId(id: string, userId: string): Promise<IOrganizationDocument | null>;

  /**
   * Increment the current storage size of an organization
   * @param organizationId - The ID of the organization
   * @param count - The amount to increment by (can be negative for decrements)
   */
  incrementCurrentStorage(organizationId: string, count: number): Promise<void>;

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

  /**
   * Update a user's usage details within an organization.
   * Uses $inc for creditsDelta (atomic increment) and $set for lastCreditUsedAt.
   * The caller must ensure the row exists first (see `ensureUserDetails`); the positional update
   * cannot create a missing row and no-ops if one is absent.
   *
   * @param organizationId - The ID of the organization
   * @param userId - The ID of the user within the organization
   * @param updates - creditsDelta uses $inc for atomicity, lastCreditUsedAt uses $set
   */
  updateUserDetails(
    organizationId: string,
    userId: string,
    updates: { creditsDelta?: number; lastCreditUsedAt?: Date }
  ): Promise<void>;
}
