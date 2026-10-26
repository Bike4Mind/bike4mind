/**
 * API-key scope posture of a route, from its apiRouteInventory.ts analysis. Every route that accepts
 * an API key must name the scopes a key needs (`requiredScopes`), refuse keys (`auth: 'jwtOnly'`),
 * or be listed in routeScopePostureBaseline.ts. Enforced by checkRouteScopePosture.test.ts.
 */
import type { RouteAnalysis } from './apiRouteInventory';

export type ScopePosture =
  { kind: 'scoped' } | { kind: 'no-key' } | { kind: 'unscoped' } | { kind: 'unclassified'; reason: string };

export const UNCLASSIFIED_REASONS = {
  dynamicAuth: 'auth option is not a static literal',
  routerUnion: 'several baseApi routers in one file; scopes are read as their union',
} as const;

const BASE_API_CALL = /\bbaseApi\s*\(/g;

/**
 * `optional` counts as key-accepting: optionalAuth installs the API-key shim with no scopes, and the
 * analyzer does not tell it apart from the JWT-only optionalJwtAuth.
 */
export function classifyScopePosture(analysis: RouteAnalysis, source: string): ScopePosture {
  if (analysis.auth.includes('unknown')) return { kind: 'unclassified', reason: UNCLASSIFIED_REASONS.dynamicAuth };
  if (!analysis.auth.some(mode => mode === 'jwt+key' || mode === 'optional')) return { kind: 'no-key' };
  if (analysis.scopes.length === 0) return { kind: 'unscoped' };
  if (analysis.methodScopes?.some(group => group.scopes.length === 0)) return { kind: 'unscoped' };
  if (!analysis.contracted && (source.match(BASE_API_CALL)?.length ?? 0) > 1) {
    return { kind: 'unclassified', reason: UNCLASSIFIED_REASONS.routerUnion };
  }
  return { kind: 'scoped' };
}

export type ScopeBaseline = {
  /** Routes that accepted any API key when this check was introduced. Only ever shrinks. */
  legacyUnscoped: readonly string[];
  /** Routes reviewed to accept any API key, each with the reason. */
  reviewedUnscoped: Readonly<Record<string, string>>;
  /** Routes whose posture static analysis cannot read, each with the classifier's reason. */
  unclassified: Readonly<Record<string, string>>;
};

export type PostureRoute = { route: string; file: string; posture: ScopePosture };

const BASELINE_FILE = 'packages/scripts/src/routeScopePostureBaseline.ts';

/** Human-readable failures; empty when every route has a deliberate posture and no entry is stale. */
export function scopePostureFailures(routes: readonly PostureRoute[], baseline: ScopeBaseline): string[] {
  const failures: string[] = [];
  const byRoute = new Map(routes.map(entry => [entry.route, entry]));
  const legacy = new Set(baseline.legacyUnscoped);

  for (const { route, file, posture } of routes) {
    if (posture.kind === 'unscoped' && !legacy.has(route) && !(route in baseline.reviewedUnscoped)) {
      failures.push(
        `${route} (${file}) accepts API keys but declares no requiredScopes. Do one of: add requiredScopes ` +
          `to its baseApi options (or its contract); set auth: 'jwtOnly' if API keys should not reach it; ` +
          `or, if any key may call it, add it to reviewedUnscoped in ${BASELINE_FILE} with the reason.`
      );
    }
    if (posture.kind === 'unclassified' && baseline.unclassified[route] !== posture.reason) {
      failures.push(
        `${route} (${file}) has an API-key scope posture static analysis cannot read (${posture.reason}). ` +
          `Make it readable (a literal baseApi options object, one router per file), or add ` +
          `'${route}': '${posture.reason}' to unclassified in ${BASELINE_FILE} after checking its scopes by hand.`
      );
    }
  }

  const stale = (route: string, list: string, expected: ScopePosture['kind']) => {
    const current = byRoute.get(route);
    if (!current) {
      failures.push(`${route} is listed in ${list} in ${BASELINE_FILE} but no longer exists. Remove the entry.`);
    } else if (current.posture.kind !== expected) {
      failures.push(
        `${route} is listed in ${list} in ${BASELINE_FILE} but is now ${current.posture.kind}. Remove the entry.`
      );
    }
  };
  for (const route of baseline.legacyUnscoped) {
    stale(route, 'legacyUnscoped', 'unscoped');
    if (route in baseline.reviewedUnscoped) failures.push(`${route} is in both legacyUnscoped and reviewedUnscoped.`);
  }
  for (const [route, reason] of Object.entries(baseline.reviewedUnscoped)) {
    stale(route, 'reviewedUnscoped', 'unscoped');
    if (!reason.trim()) failures.push(`${route} in reviewedUnscoped needs a reason.`);
  }
  for (const route of Object.keys(baseline.unclassified)) stale(route, 'unclassified', 'unclassified');
  return failures;
}
