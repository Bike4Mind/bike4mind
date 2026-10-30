/**
 * Predefined user tags for role-based access control and model permissions.
 *
 * 'Analyst' was removed 2026-07-08 (admin-roles-product-access-redesign M3):
 * the `isAnalyst`/`userIsAnalyst` helper gated no product feature, and this
 * constant's OTHER consumer - the default `allowedUserTags` seed for a new LLM
 * model config (`getDefaultModelConfig`), which `isModelAccessible` actually
 * checks - confirmed via a production query that zero real users hold
 * 'analyst' without ALSO being admin or developer (both already imply access).
 * So dropping it changes default access for nobody today. If a genuine
 * "analyst" persona is ever needed, mint a purpose-named tag then - this one's
 * name never matched what it did.
 */
export const PREDEFINED_USER_TAGS = ['Developer', 'Customer', 'Opti'] as const;

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
 * they verify their email (anti-spam - a throwaway inbox never gets credits). Set at registration
 * (and on a new self-serve OAuth account), removed by userService.releasePendingFreeCredits once a
 * real inbox is proven - see IUser.pendingCreditGrant for the release paths. Shared between the registration
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

/** Shared challenge action for requesting an email login code. */
export const TURNSTILE_ACTION_OTC_SEND = 'otc-send';

/** Shared challenge action for starting a self-serve OAuth sign-in. */
export const TURNSTILE_ACTION_OAUTH_START = 'oauth-start';

/** Query parameter that carries the solved token to the OAuth start route. */
export const TURNSTILE_OAUTH_TOKEN_PARAM = 'turnstileToken';

/**
 * Providers whose sign-in is open to anyone and so run the challenge before the provider
 * redirect. Enterprise SSO (Okta, SAML) is configured per organisation and stays unchallenged.
 */
export const TURNSTILE_OAUTH_PROVIDERS = ['google', 'github', 'facebook'] as const;
export type TurnstileOAuthProvider = (typeof TURNSTILE_OAUTH_PROVIDERS)[number];
export const isTurnstileOAuthProvider = (provider: unknown): provider is TurnstileOAuthProvider =>
  typeof provider === 'string' && (TURNSTILE_OAUTH_PROVIDERS as readonly string[]).includes(provider);

/**
 * Entitlement key held by a user with an active paid ladder plan (Basic or Pro, org seats included)
 * or a credit purchase (`lastCreditsPurchasedAt`). Derived only from those in
 * apps/client/server/entitlements/index.ts, never from a tag,
 * partner rule or contribution (reserved in isReservedContributionKey). The free-tier model gate in
 * b4m-core/services/src/llm/modelAdmission.ts reads it.
 */
export const PAID_PLAN_ENTITLEMENT_KEY = 'plan:paid';
