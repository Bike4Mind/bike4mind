import { ApiKeyScope } from '../types/entities/UserApiKeyTypes';

/**
 * The API-key scope sets the data-lake doors accept (OR semantics). The single source for both the
 * SPA routes (`apps/client/server/dataLakes/dataLakeScopes.ts` re-exports these) and the public
 * `/api/v1/data-lakes/*` contracts, so the two families cannot drift on which key opens which door.
 *
 * Query implies read: a key minted with exactly `datalake:query` still has to reach the read-gated
 * routes the in-REPL RLM tools call back into (e.g. GET /api/data-lakes/articles, replayed with the
 * caller's own credential - see rlm-answer.ts). Without it, a key holding only the scope the
 * feature advertises 403s mid-call.
 */
export const DATA_LAKE_READ_API_KEY_SCOPES = [
  ApiKeyScope.DATALAKE_READ,
  ApiKeyScope.DATALAKE_WRITE,
  ApiKeyScope.DATALAKE_QUERY,
] as const satisfies readonly ApiKeyScope[];

export const DATA_LAKE_WRITE_API_KEY_SCOPES = [ApiKeyScope.DATALAKE_WRITE] as const satisfies readonly ApiKeyScope[];

/**
 * Query-ONLY: a `datalake:read` key still cannot call a route that spends LLM/search budget against
 * a lake, even though the read set above admits `datalake:query` (query implies read, not the other
 * way around). It is its own scope for a UI reason too: `datalake:read` ends in `:read` and
 * auto-joins the New-Key modal's "Read-only" preset, which must stay non-spending.
 */
export const DATA_LAKE_QUERY_API_KEY_SCOPES = [ApiKeyScope.DATALAKE_QUERY] as const satisfies readonly ApiKeyScope[];
