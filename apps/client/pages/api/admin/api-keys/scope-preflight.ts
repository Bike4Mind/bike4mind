import { ApiKeyScope, IApiKeyScopePreflight, IApiKeyScopePreflightRow } from '@bike4mind/common';
import { apiKeyUsageLogRepository, userApiKeyRepository } from '@bike4mind/database/auth';
import { BadRequestError } from '@bike4mind/utils';
import mongoose from 'mongoose';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { decideScopeGate, parseStagedScopes, SCOPE_STAGING_ENV_VAR } from '@server/middlewares/apiKeyScopeGate';
import { ForbiddenError } from '@server/utils/errors';

/** ApiKeyUsageLog's TTL is 90 days, so a longer window would silently return less. */
const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 90;
const MAX_ROWS = 500;

/**
 * HTTP surfaces whose API-key traffic is NEVER in ApiKeyUsageLog.
 *
 * The collection has exactly one writer: `baseApi` -> `apiKeyAuth`'s `res.finish`
 * hook (apps/client/server/middlewares/apiKeyAuth.ts). Everything authenticated
 * through `verifyApiKey` (apps/client/server/cli/auth.ts) - public contract routes
 * via `resolveContractAuth`, and the embed surfaces - logs nothing. A preflight
 * over those paths returns zero rows however busy they are, which would make this
 * tool assert the one thing it must never assert: a false "nobody calls these".
 *
 * Must stay in sync with the routes wired through `resolveContractAuth` and
 * `verifyEmbedKeyById`. A path added there and not here reads as a real empty
 * result. The runbook's "Staging applies to the `baseApi` gate only" paragraph
 * (docs/architecture/api-key-scope-rollout.md) describes the same boundary.
 */
const UNLOGGED_ENDPOINT_PREFIXES = ['/api/ai/v1', '/api/embed'] as const;

const ALL_SCOPES: ReadonlySet<string> = new Set<string>(Object.values(ApiKeyScope));

/** Outcome ordering: the operator wants the keys that break at the top. */
const OUTCOME_RANK: Record<IApiKeyScopePreflightRow['outcome'], number> = {
  deny: 0,
  stagedAllow: 1,
  allow: 2,
};

function readSingle(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The unlogged surface `prefix` sits entirely within, if any. Zero rows there proves nothing. */
function enclosingUnloggedSurface(prefix: string): string | undefined {
  return UNLOGGED_ENDPOINT_PREFIXES.find(unlogged => prefix === unlogged || prefix.startsWith(`${unlogged}/`));
}

/**
 * Unlogged surfaces swept up by a broader `prefix` (`/api/` contains both). The
 * result is real but partial: those routes contribute no rows. The inverse case -
 * a prefix sitting inside a surface - is rejected outright above, so it cannot
 * reach here.
 */
function unloggedSurfacesUnder(prefix: string): string[] {
  return UNLOGGED_ENDPOINT_PREFIXES.filter(unlogged => unlogged.startsWith(prefix));
}

/**
 * GET /api/admin/api-keys/scope-preflight
 *   ?endpointPrefix=/api/some/prefix
 *   &scopes=a:read,a:write
 *   &days=90
 *
 * Admin-only. Answers the question a scope rollout actually needs: *which live
 * API keys would start getting 403s* if `scopes` were declared as
 * `requiredScopes` on the routes under `endpointPrefix`.
 *
 * This exists because a key holds only the scopes it was minted with, so
 * declaring a gate on routes that never had one rejects every caller already in
 * circulation. The documented fallback (docs/architecture/api-key-scope-rollout.md)
 * is to stage the scope and read the re-mint backlog off a log line - but that is
 * discovery by traffic, and a key that fires monthly never appears in a two-week
 * staging window. This reads the history in ApiKeyUsageLog instead - up to the
 * collection's 90-day TTL - so the list covers anything that has actually called
 * the routes in that window, capped at MAX_ROWS with `truncated` set when the cap
 * is hit.
 *
 * The verdict per key comes from `decideScopeGate` - the same function the
 * runtime gate uses - so this cannot drift from enforcement. That also means the
 * `stagedAllow` rows reflect API_KEY_SCOPE_STAGING *as set on the stage serving
 * this request*, which is the stage whose rollout you are planning.
 *
 * The one thing it must never do is report a confident zero. `ApiKeyUsageLog` is
 * written only by `baseApi`, so a prefix served by `verifyApiKey` is rejected
 * outright, a broader prefix that merely contains one reports the invisible
 * surfaces in `coverage.unloggedPrefixes`, and a sub-TTL window clears
 * `coverage.fullWindow`. An empty row list is safe to act on only when `coverage`
 * is clean on both counts.
 *
 * One blind spot `coverage` does not model, because it opens only after a gate is
 * already live: the scope 403 throws before `apiKeyAuth` registers its
 * `res.finish` usage-log hook, so a *denied* request writes no row. Traffic here
 * is therefore pre-enforcement traffic. On a prefix that already requires a scope,
 * the keys it is rejecting today contribute nothing, and once their last passing
 * request ages out of the TTL an empty result says only "nobody is getting through",
 * not "nobody is calling". Nothing new breaks from acting on that - those keys are
 * already failing - but it is not the same statement as a true zero.
 *
 * Read-only by design: it produces the list, a human rotates the keys.
 */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const query = req.query as Record<string, string | string[] | undefined>;

    const endpointPrefix = readSingle(query.endpointPrefix)?.trim();
    if (!endpointPrefix || !endpointPrefix.startsWith('/')) {
      throw new BadRequestError('endpointPrefix is required and must start with "/"');
    }
    // Refuse rather than answer "zero keys" for a prefix that structurally cannot
    // produce a row. Returning an empty result here would be a false statement of
    // fact, and acting on it breaks live keys with no grace period, because the
    // gate on these routes is enforced by `verifyApiKey`, which has no staging path.
    const enclosingUnlogged = enclosingUnloggedSurface(endpointPrefix);
    if (enclosingUnlogged) {
      throw new BadRequestError(
        `${endpointPrefix} is served by verifyApiKey, not baseApi, so no API-key traffic to it is ` +
          `logged and this preflight can only ever return zero keys. Routes under ${enclosingUnlogged} ` +
          `need no preflight: every scope they gate is bound to a credential minted with it, so there ` +
          `is no grandfathered population. See docs/architecture/api-key-scope-rollout.md.`
      );
    }

    const rawScopes = readSingle(query.scopes) ?? '';
    const requestedScopes = rawScopes
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (requestedScopes.length === 0) {
      throw new BadRequestError('scopes is required (comma-separated)');
    }
    // Fail loudly on a typo. Silently dropping an unknown scope would narrow the
    // required set and under-report who breaks - the one error this tool must not make.
    const unknown = requestedScopes.filter(s => !ALL_SCOPES.has(s));
    if (unknown.length > 0) {
      throw new BadRequestError(`Unknown scope(s): ${unknown.join(', ')}`);
    }
    const requiredScopes = requestedScopes as ApiKeyScope[];

    const rawDays = readSingle(query.days);
    const parsedDays = rawDays === undefined ? DEFAULT_WINDOW_DAYS : Number(rawDays);
    if (!Number.isFinite(parsedDays) || parsedDays < 1) {
      throw new BadRequestError('days must be a positive number');
    }
    const windowDays = Math.min(Math.floor(parsedDays), MAX_WINDOW_DAYS);

    // Fetch one past the cap so `truncated` is exact: `length === MAX_ROWS` alone
    // cannot tell "exactly MAX_ROWS keys" from "MAX_ROWS of more", and reporting a
    // complete list as partial sends the operator narrowing a prefix for no reason.
    const fetched = await apiKeyUsageLogRepository.findKeyTrafficByEndpointPrefix({
      endpointPrefix,
      days: windowDays,
      limit: MAX_ROWS + 1,
    });
    const truncated = fetched.length > MAX_ROWS;
    const traffic = truncated ? fetched.slice(0, MAX_ROWS) : fetched;

    // keyId comes from 90 days of historical log rows, so one unparseable value
    // must not sink the whole report: an unfiltered $in raises a Mongoose
    // CastError, which errorHandler rewrites to 404 "Resource not found" - and an
    // operator reads that as "no data", the worst way for this tool in particular
    // to fail. Ids dropped here resolve to no scopes below and are still reported
    // as would-403, which is the safe direction.
    const lookupIds = traffic.map(t => t.keyId).filter(id => mongoose.Types.ObjectId.isValid(id));
    // Project to `scopes`: this handler reads one field, and an unprojected find
    // hydrates the whole UserApiKey document - `keyHash` included, since that
    // schema's `toObject` has no strip transform (only `toJSON` deletes it).
    // Nothing leaks, but a credential hash has no business in this request.
    const keyDocs = lookupIds.length ? await userApiKeyRepository.find({ _id: { $in: lookupIds } }, { scopes: 1 }) : [];
    const scopesByKeyId = new Map<string, ApiKeyScope[]>(keyDocs.map(doc => [String(doc.id), doc.scopes ?? []]));

    const { staged } = parseStagedScopes(process.env[SCOPE_STAGING_ENV_VAR]);

    const rows: IApiKeyScopePreflightRow[] = traffic
      .map(entry => {
        // A key absent from UserApiKey was deleted after its last logged call.
        // Treat it as holding nothing: it cannot be re-minted, and reporting it
        // as `allow` would hide a row the operator should still see.
        const heldScopes = scopesByKeyId.get(entry.keyId) ?? [];
        const { outcome } = decideScopeGate(requiredScopes, heldScopes, staged);
        return { ...entry, heldScopes, outcome };
      })
      .sort((a, b) => OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome] || b.requests - a.requests);

    const payload: IApiKeyScopePreflight = {
      endpointPrefix,
      requiredScopes,
      windowDays,
      stagedScopes: [...staged],
      rows,
      truncated,
      coverage: {
        fullWindow: windowDays === MAX_WINDOW_DAYS,
        unloggedPrefixes: unloggedSurfacesUnder(endpointPrefix),
      },
    };

    return res.status(200).json(payload);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
