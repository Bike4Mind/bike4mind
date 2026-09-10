import { ApiKeyScope } from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';
import { decideScopeGate, parseStagedScopes, SCOPE_STAGING_ENV_VAR } from '@server/middlewares/apiKeyScopeGate';

/**
 * The `requiredScopes` lists every `/api/data-lakes` route declares, and the
 * per-method asserts the mixed-method routes use on top of them. One place, so
 * "which scope does this door need" cannot drift route by route.
 *
 * `admin:*` is deliberately absent from all of them. A route is in its staging
 * grace period only while EVERY scope it accepts is staged (decideScopeGate),
 * and `admin:*` can never be staged - listing it would leave this whole family
 * with no grace period and 403 every key in circulation the minute the gate
 * deploys. An admin key that calls a lake route is part of the same re-mint list
 * as any other key. See docs/architecture/api-key-scope-rollout.md.
 */
export const DATA_LAKE_READ_SCOPES: ApiKeyScope[] = [ApiKeyScope.DATALAKE_READ, ApiKeyScope.DATALAKE_WRITE];

export const DATA_LAKE_WRITE_SCOPES: ApiKeyScope[] = [ApiKeyScope.DATALAKE_WRITE];

export const DATA_LAKE_SHARE_SCOPES: ApiKeyScope[] = [ApiKeyScope.DATALAKE_SHARE];

/**
 * Gate for a route that spends LLM/search budget against a lake (semantic-search, rlm-answer).
 * Deliberately its own scope, not a member of DATA_LAKE_READ_SCOPES - `datalake:read` ends in
 * `:read` and auto-joins the New-Key modal's "Read-only" preset, which must stay non-spending.
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
 * for them and this must not either.
 */
function assertScope(req: ScopedRequest, required: ApiKeyScope[], message: string): void {
  const held = req.apiKeyInfo?.scopes;
  if (!held) return;
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
