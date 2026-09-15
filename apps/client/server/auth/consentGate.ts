/**
 * P0-B abuse gate - pure decision logic for the AUP/ToS acceptance middleware in
 * auth.ts. Extracted so it can be unit-tested without importing the full passport/strategy chain.
 *
 * See auth.ts for the enforcement wiring and the fail-closed rationale.
 */

/**
 * Endpoints a brand-new, not-yet-consented account must still reach to unlock itself. Everything
 * else is blocked (403) until acceptance is recorded. Matched via `req.url.startsWith(path)` AND
 * an exact `req.method` match - the allowlist is method-scoped so a non-consented account cannot
 * reach the WRITE surface under a bootstrap prefix (e.g. `POST /api/users/:id/update`,
 * `/api/users/:id/agents`) just because the self-GET on the same prefix is allowed. Only the exact
 * (path-prefix, method) pairs the pre-consent bootstrap actually needs are open.
 *
 * NOTE: `/api/user/accept-policies` is SINGULAR (`/user/`); the profile routes are plural
 * (`/api/users/`). Both are here for distinct reasons - do not conflate them.
 */
export const POLICY_CONSENT_ALLOWLIST = [
  { path: '/api/user/accept-policies', methods: ['POST'] }, // the recording endpoint
  { path: '/api/identify', methods: ['GET'] }, // interstitial + app bootstrap read the current user
  // auth/success bootstraps currentUser via GET /api/users/:id (self). Prefix+GET also admits
  // GET /api/users/<anyId> pre-consent, but the gate is not the authz control there - each users
  // route enforces its own CASL/projection, so a non-consented account can't read arbitrary
  // profiles. The allowlist only decides "does the consent gate step aside"; it defers to the
  // endpoint's own authz for the non-self case.
  { path: '/api/users/', methods: ['GET'] },
  { path: '/api/logout', methods: ['GET'] }, // let a trapped user sign out (client calls GET /api/logout)
] as const;

/** Minimal shape the gate reads off req.user. Exported so callers cast to it instead of `any`. */
export interface ConsentGateUser {
  aupAcceptedVersion?: string | null;
  isSystem?: boolean;
}

/**
 * True when this account satisfies the AUP/ToS acceptance gate: a system/service account (never
 * required to attest) or any account with a recorded acceptance version (a real version OR the
 * grandfather sentinel). Falsy `aupAcceptedVersion` (absent/null/empty) means "not accepted".
 *
 * This is THE reusable predicate - it is applied both by the REST middleware (`isPolicyConsentRequired`
 * below, wired in auth.ts) and by the CLI/WebSocket JWT primitive (`verifyJwtToken` in cli/auth.ts),
 * so every authenticated surface - REST, WS, and the LLM function-URL Lambdas - enforces the same
 * fail-closed rule at its own chokepoint. Keep it presence-only to match the gate's semantics.
 */
export const hasAcceptedPolicy = (user: ConsentGateUser): boolean => Boolean(user.isSystem || user.aupAcceptedVersion);

/**
 * True when this request must be blocked pending policy acceptance: an authenticated account that
 * has NOT accepted (see `hasAcceptedPolicy`) and is targeting a request that is not an exact
 * (path-prefix, method) match on the bootstrap allowlist.
 */
export const isPolicyConsentRequired = (user: ConsentGateUser | undefined, url: string, method: string): boolean => {
  if (!user) return false;
  if (hasAcceptedPolicy(user)) return false;
  return !POLICY_CONSENT_ALLOWLIST.some(
    entry => url.startsWith(entry.path) && (entry.methods as readonly string[]).includes(method)
  );
};
