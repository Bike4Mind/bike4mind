/**
 * API-key scope posture of a route, from its apiRouteInventory.ts analysis. Every route that accepts
 * an API key must name the scopes a key needs (`requiredScopes`), refuse keys (`auth: 'jwtOnly'`),
 * or be listed in routeScopePostureBaseline.ts. Enforced by checkRouteScopePosture.test.ts.
 */
import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { HttpMethod, RouteAnalysis } from './apiRouteInventory';

export type ScopePosture =
  | { kind: 'scoped' }
  | { kind: 'no-key' }
  /** `verbs`: set when only some verbs of a contracted route lack scopes. */
  | { kind: 'unscoped'; verbs?: HttpMethod[] }
  | { kind: 'unclassified'; reason: string };

export const UNCLASSIFIED_REASONS = {
  dynamicAuth: 'auth option is not a static literal',
  routerUnion: 'several baseApi routers in one file; scopes are read as their union',
} as const;

/** A route can install the API-key shim itself (e.g. under `auth: false`); its scope argument is not read. */
const DIRECT_KEY_SHIM = /\bapiKeyAuth\s*\(/;

function hasSeveralRouters(source: string): boolean {
  const file = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  let routerCount = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'baseApi') {
      routerCount += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return routerCount > 1;
}

/**
 * `optional` counts as key-accepting: optionalAuth installs the API-key shim with no scopes, and the
 * analyzer does not tell it apart from the JWT-only optionalJwtAuth.
 */
export function classifyScopePosture(analysis: RouteAnalysis, source: string): ScopePosture {
  if (analysis.auth.includes('unknown')) return { kind: 'unclassified', reason: UNCLASSIFIED_REASONS.dynamicAuth };
  const acceptsKey =
    analysis.auth.some(mode => mode === 'jwt+key' || mode === 'optional') || DIRECT_KEY_SHIM.test(source);
  if (!acceptsKey) return { kind: 'no-key' };
  if (!analysis.auth.includes('jwt+key')) return { kind: 'unscoped' };
  if (analysis.scopes.length === 0) return { kind: 'unscoped' };
  const verbs = analysis.methodScopes?.filter(group => group.scopes.length === 0).flatMap(group => group.methods);
  if (verbs?.length) return { kind: 'unscoped', verbs };
  if (!analysis.contracted && hasSeveralRouters(source)) {
    return { kind: 'unclassified', reason: UNCLASSIFIED_REASONS.routerUnion };
  }
  return { kind: 'scoped' };
}

export type ScopeBaseline = {
  /** Routes that accepted any API key when this check was introduced. Only ever shrinks. */
  legacyUnscoped: readonly string[];
  /** Digests of remaining legacy routes; prune alongside legacyUnscoped. */
  legacySeed: ReadonlySet<string>;
  /** Routes reviewed to accept any API key, each with the reason. */
  reviewedUnscoped: Readonly<Record<string, string>>;
  /** Routes whose posture static analysis cannot read, each with the classifier's reason. */
  unclassified: Readonly<Record<string, string>>;
};

export type PostureRoute = { route: string; file: string; posture: ScopePosture };

const BASELINE_FILE = 'packages/scripts/src/routeScopePostureBaseline.ts';

export const legacyDigest = (route: string) => createHash('sha256').update(route).digest('hex').slice(0, 12);

const fixes = (route: string) =>
  `Do one of: add requiredScopes to its baseApi options (or its contract); set auth: 'jwtOnly' if API ` +
  `keys should not reach it; or, if any key may call it, add '${route}' to reviewedUnscoped in ` +
  `${BASELINE_FILE} with the reason.`;

/** Human-readable failures; empty when every route has a deliberate posture and no entry is stale. */
export function scopePostureFailures(routes: readonly PostureRoute[], baseline: ScopeBaseline): string[] {
  const failures: string[] = [];
  const byRoute = new Map(routes.map(entry => [entry.route, entry]));
  const legacy = new Set(baseline.legacyUnscoped);
  const legacyDigests = new Set(baseline.legacyUnscoped.map(legacyDigest));
  for (const digest of baseline.legacySeed) {
    if (!legacyDigests.has(digest)) {
      failures.push(`${digest} in legacySeed has no legacyUnscoped route. Remove the digest from ${BASELINE_FILE}.`);
    }
  }

  for (const { route, file, posture } of routes) {
    if (posture.kind === 'unscoped' && !legacy.has(route) && !(route in baseline.reviewedUnscoped)) {
      failures.push(
        posture.verbs
          ? `${route} (${file}) accepts API keys on ${posture.verbs.join(', ')} with no scopes. Its contract ` +
              `declares scopes for the other verbs (methodScopes). If ${posture.verbs.join(', ')} is a jwtOnly ` +
              `operation, this is a known false positive (verbs are grouped by scopes, not auth): list the route ` +
              `in reviewedUnscoped saying so. ${fixes(route)}`
          : `${route} (${file}) accepts API keys but declares no requiredScopes. ${fixes(route)}`
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
    if (!baseline.legacySeed.has(legacyDigest(route))) {
      failures.push(
        `${route} was added to legacyUnscoped, which only lists routes from when this check was introduced ` +
          `and can only shrink. Remove it from legacyUnscoped. ${fixes(route)}`
      );
      continue;
    }
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
