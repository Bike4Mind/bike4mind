import { ApiKeyScope } from '@bike4mind/common';

/**
 * Env var naming the scopes whose route gates are still being rolled out, e.g.
 * `API_KEY_SCOPE_STAGING=optihashi:read,optihashi:compute`. Unset (the default)
 * means every declared `requiredScopes` gate enforces normally.
 *
 * This exists because declaring `requiredScopes` on a route that never had one
 * 403s every key already in production the moment it deploys - keys hold only
 * what they were minted with. The rollout is: declare the gate with the scope
 * staged, re-mint the keys in circulation, then drop the entry here. See
 * docs/architecture/api-key-scope-rollout.md.
 *
 * Scoped deliberately to the `baseApi`/`apiKeyAuth` gate. The other scope check -
 * `verifyApiKey` (server/cli/auth.ts), which backs public contract routes, the
 * cc-bridge, and embed keys - has no staging path and needs none: every gate it
 * runs is either bound to a credential minted with that exact scope or belongs to
 * an endpoint that shipped with its scope from day one, so there is no
 * grandfathered population there to protect. Adding a second fail-open path would
 * be surface, not safety.
 */
export const SCOPE_STAGING_ENV_VAR = 'API_KEY_SCOPE_STAGING';

/**
 * Scopes that may never be staged. Staging `admin:*` would silently open every
 * admin-gated route to any valid key, and the dedicated-flow scopes below have
 * no grandfathered population to protect - each is bound to a credential minted
 * with it (bridge pairing, embed widget, Overwatch ingest), so there is nothing
 * a grace period could rescue.
 */
const UNSTAGEABLE_SCOPES: ReadonlySet<string> = new Set<string>([
  ApiKeyScope.ADMIN,
  ApiKeyScope.CC_BRIDGE,
  ApiKeyScope.EMBED_CHAT,
  ApiKeyScope.OVERWATCH_INGEST_WRITE,
]);

const ALL_SCOPE_VALUES: ReadonlySet<string> = new Set<string>(Object.values(ApiKeyScope));

export type ScopeGateDecision =
  /** The key holds a required scope, or the route declares none. */
  | { outcome: 'allow' }
  /** No required scope held, and every one of them is staged - let it through, but say so. */
  | { outcome: 'stagedAllow'; stagedScopes: ApiKeyScope[] }
  /** No required scope held. */
  | { outcome: 'deny' };

/**
 * Parses {@link SCOPE_STAGING_ENV_VAR}. Entries that are not real scope values,
 * or that are listed in {@link UNSTAGEABLE_SCOPES}, are dropped and reported in
 * `rejected` so the caller can log them - a typo must not quietly read as "that
 * gate is staged".
 */
export function parseStagedScopes(raw: string | undefined): {
  staged: ReadonlySet<string>;
  rejected: string[];
} {
  const staged = new Set<string>();
  const rejected: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const value = entry.trim();
    if (!value) continue;
    if (ALL_SCOPE_VALUES.has(value) && !UNSTAGEABLE_SCOPES.has(value)) {
      staged.add(value);
    } else {
      rejected.push(value);
    }
  }
  return { staged, rejected };
}

/**
 * The scope gate's whole decision, isolated from Express so it can be tested
 * directly.
 *
 * `requiredScopes` is OR semantics: holding any one of them passes. Staging is
 * therefore all-or-nothing across the list - a route is only in its grace period
 * when *every* alternative is still staged. If even one required scope is
 * already enforced, a key that legitimately needs the route could already have
 * been minted with it, so a key holding none of them is not grandfathered and is
 * denied.
 */
export function decideScopeGate(
  requiredScopes: ApiKeyScope[] | undefined,
  heldScopes: ApiKeyScope[] | undefined,
  staged: ReadonlySet<string>
): ScopeGateDecision {
  if (!requiredScopes) return { outcome: 'allow' };
  if (requiredScopes.some(scope => heldScopes?.includes(scope))) return { outcome: 'allow' };
  // An empty `requiredScopes` denies (a route asking for "one of nothing" can
  // satisfy nobody); `every` on [] is true, so guard the length explicitly.
  if (requiredScopes.length > 0 && requiredScopes.every(scope => staged.has(scope))) {
    return { outcome: 'stagedAllow', stagedScopes: requiredScopes };
  }
  return { outcome: 'deny' };
}
