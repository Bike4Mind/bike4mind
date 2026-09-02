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

    const traffic = await apiKeyUsageLogRepository.findKeyTrafficByEndpointPrefix({
      endpointPrefix,
      days: windowDays,
      limit: MAX_ROWS,
    });

    // keyId comes from 90 days of historical log rows, so one unparseable value
    // must not sink the whole report: an unfiltered $in raises a Mongoose
    // CastError, which errorHandler rewrites to 404 "Resource not found" - and an
    // operator reads that as "no data", the worst way for this tool in particular
    // to fail. Ids dropped here resolve to no scopes below and are still reported
    // as would-403, which is the safe direction.
    const lookupIds = traffic.map(t => t.keyId).filter(id => mongoose.Types.ObjectId.isValid(id));
    const keyDocs = lookupIds.length ? await userApiKeyRepository.find({ _id: { $in: lookupIds } }) : [];
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
      truncated: traffic.length === MAX_ROWS,
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
