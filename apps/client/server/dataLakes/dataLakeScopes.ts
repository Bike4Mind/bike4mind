import { ApiKeyScope, type IDataLakeRepository } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { ForbiddenError } from '@server/utils/errors';
import { decideScopeGate, parseStagedScopes, SCOPE_STAGING_ENV_VAR } from '@server/middlewares/apiKeyScopeGate';

/**
 * The `requiredScopes` lists every `/api/data-lakes` route declares, and the
 * per-method asserts the mixed-method routes use on top of them. One place, so
 * "which scope does this door need" cannot drift route by route. A few sibling
 * doors outside `/api/data-lakes` (`files/tags/toggle.ts` and its presign/create
 * cousins) that write a lake's membership through a caller-supplied tag also
 * import `assertDataLakeTagWriteScope` from here - see that function's doc.
 *
 * `admin:*` is deliberately absent from all of them. A route is in its staging
 * grace period only while EVERY scope it accepts is staged (decideScopeGate),
 * and `admin:*` can never be staged - listing it would leave this whole family
 * with no grace period and 403 every key in circulation the minute the gate
 * deploys. An admin key that calls a lake route is part of the same re-mint list
 * as any other key. See docs/architecture/api-key-scope-rollout.md.
 */
export const DATA_LAKE_READ_SCOPES: ApiKeyScope[] = [
  ApiKeyScope.DATALAKE_READ,
  ApiKeyScope.DATALAKE_WRITE,
  // Query implies read: a key minted with exactly `datalake:query` still has to reach the
  // read-gated routes the in-REPL RLM tools call back into (e.g. GET /api/data-lakes/articles,
  // replayed with the caller's own credential - see rlm-answer.ts). Without this, a key holding
  // only the scope the feature advertises 403s mid-call.
  ApiKeyScope.DATALAKE_QUERY,
];

export const DATA_LAKE_WRITE_SCOPES: ApiKeyScope[] = [ApiKeyScope.DATALAKE_WRITE];

export const DATA_LAKE_SHARE_SCOPES: ApiKeyScope[] = [ApiKeyScope.DATALAKE_SHARE];

/**
 * Gate for a route that spends LLM/search budget against a lake (semantic-search, rlm-answer).
 * This array is query-ONLY - a `datalake:read` key still cannot call these spend routes
 * directly, even though `DATA_LAKE_READ_SCOPES` above admits `DATALAKE_QUERY` (query implies
 * read for the READ gate's own routes, not the other way around). `datalake:query` is its own
 * scope for a UI reason too: `datalake:read` ends in `:read` and auto-joins the New-Key modal's
 * "Read-only" preset, which must stay non-spending.
 */
export const DATA_LAKE_QUERY_SCOPES: ApiKeyScope[] = [ApiKeyScope.DATALAKE_QUERY];

/** Gate for a route whose read method is open to readers and whose write method re-shares the lake. */
export const DATA_LAKE_READ_OR_SHARE_SCOPES: ApiKeyScope[] = [...DATA_LAKE_READ_SCOPES, ApiKeyScope.DATALAKE_SHARE];

interface ScopedRequest {
  apiKeyInfo?: { scopes?: ApiKeyScope[] };
}

/**
 * `baseApi`'s gate is per route, not per method, so a route serving both a read
 * and a write declares the read gate and calls one of these inside the write
 * handler. Staging is honored here too: an in-handler assert that ignored
 * API_KEY_SCOPE_STAGING would reject exactly the grandfathered keys the staging
 * window exists to protect.
 *
 * A caller with no `apiKeyInfo` is a JWT/browser caller - the key gate never ran
 * for them and this must not either. That check is on `apiKeyInfo` itself, not on
 * `scopes`: a key caller whose `scopes` came back undefined (apiKeyAuth.ts writes
 * `scopes: validation.scopes!`, a non-null assertion over an optional field) still
 * has `apiKeyInfo` set, and treating a missing `scopes` array as "let it through"
 * would fail open for exactly the caller this gate exists to check.
 */
function assertScope(req: ScopedRequest, required: ApiKeyScope[], message: string): void {
  if (!req.apiKeyInfo) return;
  const held = req.apiKeyInfo.scopes ?? [];
  const { staged } = parseStagedScopes(process.env[SCOPE_STAGING_ENV_VAR]);
  if (decideScopeGate(required, held, staged).outcome !== 'deny') return;
  throw new ForbiddenError(message);
}

export function assertDataLakeWriteScope(req: ScopedRequest): void {
  assertScope(req, DATA_LAKE_WRITE_SCOPES, 'This API key is read-only for data lakes; datalake:write is required');
}

export function assertDataLakeShareScope(req: ScopedRequest): void {
  assertScope(
    req,
    DATA_LAKE_SHARE_SCOPES,
    'This API key cannot change who can reach a data lake; datalake:share is required'
  );
}

/**
 * Gate for a door outside `/api/data-lakes` that writes lake membership through a
 * caller-supplied tag list (`files/tags/toggle.ts`, `files/createFabFile.ts`,
 * `files/generate-presigned-url(s-batch).ts`, `files/[id]/index.ts`). These routes stay
 * ungated for a plain file-tag/upload call so a `files:write`-only key keeps working, but
 * once the tag list actually reaches into a lake (a `datalake:*` meta-tag), an API-key
 * caller must hold `datalake:write` too - otherwise a key minted for file tagging alone
 * could add/remove a file from a lake it cannot otherwise write into.
 *
 * `dataLakeTagWriteScopeCoverage.test.ts` asserts every caller of
 * `assertCanWriteDataLakeTags` also calls this, so a new door cannot land without it.
 *
 * `newFile`, when passed, additionally covers the OTHER membership signal for a file being
 * CREATED: a plain content tag matching one of the caller's own lakes' `fileTagPrefix` joins
 * that lake with no `datalake:*` meta-tag involved at all (the prefix arm - see
 * `prefixArmMembership.ts`). `currentTagNames` is always `[]` here because the file does not
 * exist yet, so anything matching a prefix arm is necessarily a JOIN, never a leave. Omitted by
 * `toggle.ts`/`[id]/index.ts`: those doors mutate an EXISTING file and already gate this signal
 * themselves, in the service layer, via `assertWriteScope` (they have the stored tag list
 * `findPrefixArmChanges` needs to diff against; this function does not).
 */
export async function assertDataLakeTagWriteScope(
  req: ScopedRequest,
  tagNames: readonly unknown[],
  newFile?: { userId: string; db: { dataLakes: Pick<IDataLakeRepository, 'find'> } }
): Promise<void> {
  if (dataLakeService.extractDataLakeMetaTags(tagNames).length > 0) {
    assertDataLakeWriteScope(req);
    return;
  }
  if (!newFile) return;
  const stringTagNames = tagNames.filter((name): name is string => typeof name === 'string');
  // Every usable fileTagPrefix ends in ':' (normalizeTagPrefix), so a colon-free tag set cannot
  // satisfy any prefix arm - skip the candidate-lake query for the common case.
  if (!stringTagNames.some(name => name.includes(':'))) return;
  const candidateLakes = await dataLakeService.loadPrefixArmCandidateLakes([newFile.userId], { db: newFile.db });
  if (candidateLakes.length === 0) return;
  const { joins } = await dataLakeService.findPrefixArmChanges(
    { fileOwnerUserId: newFile.userId, currentTagNames: [], resultingTagNames: stringTagNames },
    { db: newFile.db, candidateLakes }
  );
  if (joins.length > 0) assertDataLakeWriteScope(req);
}
