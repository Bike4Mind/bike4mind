import {
  ApiKeyScope,
  DATA_LAKE_QUERY_API_KEY_SCOPES,
  DATA_LAKE_READ_API_KEY_SCOPES,
  DATA_LAKE_TOOL_NAMES,
  DATA_LAKE_WRITE_API_KEY_SCOPES,
  DATA_LAKE_WRITE_TOOL_NAMES,
  type IDataLakeRepository,
} from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { assertApiKeyScope, holdsApiKeyScope, type ScopedRequest } from '@server/middlewares/apiKeyScopeGate';

/**
 * The `requiredScopes` lists every `/api/data-lakes` route declares, and the
 * per-method asserts the mixed-method routes use on top of them. One place, so
 * "which scope does this door need" cannot drift route by route. A few sibling
 * doors outside `/api/data-lakes` (`files/tags/toggle.ts` and its presign/create
 * cousins) that write a lake's membership through a caller-supplied tag also
 * import `assertDataLakeTagWriteScope` from here - see that function's doc.
 *
 * The org-membership doors are the other out-of-family site, for `datalake:share`:
 * DELETE `organizations/[id]/members/[userId]` declares `DATA_LAKE_SHARE_SCOPES` on
 * `baseApi`, and DELETE `organizations/[id]/members` asserts `assertDataLakeShareScope`
 * in-handler so its GET/POST keep their existing scope behaviour. Both end a departing
 * member's lake grants below the service boundary, which is why a membership route
 * needs a data-lake scope at all.
 *
 * The ownership-offer doors are the third: the transfer-ownership DELETE and the
 * recipient `ownership-offers/[offerId]/accept` and `/decline` all assert
 * `assertDataLakeShareScope`, because each one moves or settles who owns the lake.
 *
 * Keep that enumeration complete. A scope preflight is sized from the enforcement
 * sites for a scope, not from its home prefix (docs/architecture/api-key-scope-rollout.md,
 * step 2), so a `datalake:share` preflight run over `/api/data-lakes` alone would miss
 * both doors above and under-report the re-mint list.
 *
 * `admin:*` is deliberately absent from all of them. A route is in its staging
 * grace period only while EVERY scope it accepts is staged (decideScopeGate),
 * and `admin:*` can never be staged - listing it would leave this whole family
 * with no grace period and 403 every key in circulation the minute the gate
 * deploys. An admin key that calls a lake route is part of the same re-mint list
 * as any other key. See docs/architecture/api-key-scope-rollout.md.
 *
 * The read/write/query sets are copies of the constants in `@bike4mind/common`
 * (constants/dataLakeApiKeyScopes.ts), which the public `/api/v1/data-lakes`
 * contracts also declare, so both route families accept the same keys.
 */
export const DATA_LAKE_READ_SCOPES: ApiKeyScope[] = [...DATA_LAKE_READ_API_KEY_SCOPES];

export const DATA_LAKE_WRITE_SCOPES: ApiKeyScope[] = [...DATA_LAKE_WRITE_API_KEY_SCOPES];

export const DATA_LAKE_SHARE_SCOPES: ApiKeyScope[] = [ApiKeyScope.DATALAKE_SHARE];

/**
 * Gate for a route that spends LLM/search budget against a lake (semantic-search, rlm-answer).
 * Query-ONLY; the rationale lives with the shared constant in `@bike4mind/common`.
 */
export const DATA_LAKE_QUERY_SCOPES: ApiKeyScope[] = [...DATA_LAKE_QUERY_API_KEY_SCOPES];

/** Gate for a route whose read method is open to readers and whose write method re-shares the lake. */
export const DATA_LAKE_READ_OR_SHARE_SCOPES: ApiKeyScope[] = [...DATA_LAKE_READ_SCOPES, ApiKeyScope.DATALAKE_SHARE];

/**
 * Non-throwing read-scope check for a door whose data-lake reach is a fallback rather than its
 * purpose (loadAccessibleFabFile): a key without datalake:read keeps the door but not the lake.
 */
export function holdsDataLakeReadScope(req: ScopedRequest): boolean {
  return holdsApiKeyScope(req, DATA_LAKE_READ_SCOPES);
}

/**
 * The chat tools a caller may not be offered on this request: the data-lake write tools when an
 * API key lacks datalake:write, and the read tool too when it also lacks datalake:read (JWT/browser
 * callers hold every scope - see holdsScope). The chat doors (`/api/chat`, `/api/ai/llm`) pass this
 * as the turn's `deniedTools`, which is enforced at every denylist site in ChatCompletionProcess,
 * including the pass after the intent gates run.
 */
export function dataLakeToolsDeniedFor(req: ScopedRequest): string[] {
  if (holdsScope(req, DATA_LAKE_WRITE_SCOPES)) return [];
  return holdsDataLakeReadScope(req) ? [...DATA_LAKE_WRITE_TOOL_NAMES] : [...DATA_LAKE_TOOL_NAMES];
}

export function assertDataLakeWriteScope(req: ScopedRequest): void {
  assertApiKeyScope(
    req,
    DATA_LAKE_WRITE_SCOPES,
    'This API key is read-only for data lakes; datalake:write is required'
  );
}

export function assertDataLakeShareScope(req: ScopedRequest): void {
  assertApiKeyScope(
    req,
    DATA_LAKE_SHARE_SCOPES,
    'This API key cannot change who can reach a data lake; datalake:share is required'
  );
}

/**
 * Gate for a door outside `/api/data-lakes` that writes lake membership through a
 * caller-supplied tag list (`files/tags/toggle.ts`, `files/createFabFile.ts`,
 * `files/generate-presigned-url(s-batch).ts`, `files/[id]/index.ts`). These routes need
 * only `files:write` for a plain file-tag/upload call (server/files/fileScopes.ts), but
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
  // assertDataLakeWriteScope below is a no-op for a JWT/browser caller (assertApiKeyScope returns
  // early when req.apiKeyInfo is absent), so skip the DB round-trip entirely when it can only
  // ever be thrown away - this path runs on every colon-tagged upload, API key or not.
  if (!req.apiKeyInfo) return;
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
