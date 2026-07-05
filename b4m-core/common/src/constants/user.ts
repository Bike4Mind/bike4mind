/**
 * Predefined user tags for role-based access control and model permissions
 */
export const PREDEFINED_USER_TAGS = ['Developer', 'Analyst', 'Customer', 'Opti'] as const;

/**
 * Type for predefined user tags
 */
export type PredefinedUserTag = (typeof PREDEFINED_USER_TAGS)[number];

/**
 * Helper function to check if a tag is a predefined tag
 */
export const isPredefinedTag = (tag: string): tag is PredefinedUserTag => {
  return PREDEFINED_USER_TAGS.includes(tag as PredefinedUserTag);
};

/**
 * Helper function to get all predefined tags
 */
export const getPredefinedTags = (): readonly string[] => {
  return PREDEFINED_USER_TAGS;
};

/**
 * Tag marking an open-registration (no-invite) user whose free-credit grant is deferred until
 * they verify their email (anti-spam - a throwaway inbox never gets credits). Set at registration,
 * removed by `/api/email/verify` once a real inbox is proven. Shared between the registration
 * service, the verify endpoint, and the client (to show "verify to unlock your credits").
 */
export const PENDING_FREE_CREDITS_TAG = 'pending-free-credits';

/**
 * The current Acceptable Use Policy + Terms of Service version that a new account must accept
 * at creation (P0-B abuse gate). This is the SINGLE SOURCE OF TRUTH for the version
 * string: the registration service stamps it, the accept-policies endpoint stamps it, and the
 * server middleware treats the ABSENCE of a stored version as "not accepted" (fail-closed).
 *
 * Bump this when the legal text materially changes AND the fast-follow re-consent flow is built;
 * bumping alone does NOT force existing users to re-accept (that's out of scope here - the gate
 * keys off presence/absence, not equality, at read time).
 */
export const CURRENT_POLICY_VERSION = 'v1';

/**
 * Sentinel version written to pre-existing accounts by the grandfather migration
 * (20260702... backfill-policy-acceptance-grandfather). Distinguishable from a real acceptance
 * so the fast-follow re-consent work can target grandfathered users. These users never made an
 * 18+ attestation, so `ageAttestedAdult` is intentionally left absent for them.
 */
export const GRANDFATHERED_POLICY_VERSION = 'grandfathered';
