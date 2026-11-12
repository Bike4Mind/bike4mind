/**
 * An organization's service account: the `isSystem` user that holds the org's org-owned API keys,
 * so those keys survive any member leaving. One per org, found by its deterministic address.
 * It never joins the org's `users[]` roster (no seat, not a listed member); the binding is
 * `serviceAccountOrganizationId`, which the org-billing membership rule reads
 * (packages/server-utils/src/billing/assertApiKeyOrgMembership.ts, b4m-core/services/src/cliCompletions.ts,
 * b4m-core/services/src/creditService/deductCreditsWithOrgSupport.ts, creditService/memberCreditCap.ts).
 */

/** RFC 6761 reserved `.invalid` TLD: no inbox, so no email-code or OAuth sign-in can ever match it. */
export const orgServiceAccountEmail = (organizationId: string): string =>
  `org-${organizationId}@service-account.system.bike4mind.invalid`;

/** True when `user` is the service account of exactly this organization. */
export const isOrgServiceAccountOf = (
  user: { isSystem?: boolean | null; serviceAccountOrganizationId?: string | null } | null | undefined,
  organizationId: string
): boolean => !!user && user.isSystem === true && user.serviceAccountOrganizationId === organizationId;

/**
 * True when `user` is any organization's service account. Such an account may never manage API keys
 * itself: it holds all of its org's org-owned keys, so one of them could reach its siblings.
 */
export const isOrgServiceAccount = (
  user: { serviceAccountOrganizationId?: string | null } | null | undefined
): boolean => !!user?.serviceAccountOrganizationId;
