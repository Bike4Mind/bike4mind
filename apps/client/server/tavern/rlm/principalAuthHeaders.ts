import type { IncomingHttpHeaders } from 'http';

/**
 * Credential headers to replay on the REPL's loopback calls to /api/data-lakes/*
 * and /api/files/*, so those calls authenticate as the SAME principal that
 * authenticated the outer request.
 *
 * This is the whole point of the type: the data-lake routes derive their scope
 * from the authenticated principal (resolveAccessibleLakes,
 * resolveRetrievalLakeScope), so a loopback call carrying anything other than
 * the caller's own credential reads a scope the caller was never granted. There
 * is deliberately no shared/service-key path - see resolvePrincipalAuthHeaders.
 *
 * NOTE: /api/files/presigned-url does NOT scope by principal - it signs whatever
 * filePath it is handed. The only thing gating it here is that getArticle's
 * filePath came from the lake-gated articles?id= hop. Do not add a files/*
 * loopback call assuming the forwarded principal scopes it.
 */
export type PrincipalAuthHeaders = { 'x-api-key'?: string; authorization?: string };

/**
 * Forwarded verbatim rather than reconstructed: `apiKeyAuth` accepts a key as
 * `x-api-key`, `Authorization: ApiKey <key>` or `Authorization: Bearer b4m_<key>`,
 * and the JWT strategy reads `Authorization: Bearer <jwt>`. Copying both headers
 * as-is covers every accepted credential form without this module needing to know
 * which one the caller used.
 *
 * Returns null when the request carries neither header - fail closed, because the
 * alternative (a shared service key) would run the REPL's retrieval as a
 * different principal than the caller.
 */
export function resolvePrincipalAuthHeaders(headers: IncomingHttpHeaders): PrincipalAuthHeaders | null {
  const resolved: PrincipalAuthHeaders = {};
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) {
    resolved['x-api-key'] = apiKey;
  }
  const authorization = headers.authorization;
  if (typeof authorization === 'string' && authorization.trim()) {
    resolved.authorization = authorization;
  }
  return Object.keys(resolved).length > 0 ? resolved : null;
}
