import { baseApi } from './baseApi';
import { isApiKeyAuth } from './apiKeyAuth';
import { UnauthorizedError } from '@server/utils/errors';
import type { EndpointContract, RequestBodyOf } from '@bike4mind/common';
import type { Request, Response, RequestHandler } from 'express';

/**
 * Next.js transport adapter for an {@link EndpointContract}.
 *
 * Derives the route's auth mode + required scopes from the contract, enforces the
 * auth mode, and validates the body against the contract schema - exposing it to
 * the handler as the typed `req.validated`. Returns the usual `baseApi` router, so
 * callers chain `.post(...)` as before.
 *
 * Rate limiting is passed as `options.rateLimit` (rather than the caller chaining
 * its own `.use(...)`) so this adapter can order it correctly: auth -> rate limit
 * -> validation. If validation ran first, a flood of malformed bodies would 422
 * without ever touching the limiter.
 *
 * The SAME contract drives the OpenAPI spec and the Lambda adapter
 * (server/cli/defineLambdaRoute.ts): define once, derive every transport.
 */
export function nextRouteForContract<C extends EndpointContract>(
  contract: C,
  options: { maxBodySize?: number; exemptReadsFromDailyRateLimit?: boolean; rateLimit?: RequestHandler } = {}
) {
  type ValidatedReq = Request & { validated: RequestBodyOf<C> };

  const { rateLimit, ...baseOptions } = options;

  const router = baseApi<ValidatedReq, Response>({
    auth: contract.auth !== 'public',
    // Empty `scopes: []` means "no scope requirement", not "requires nothing" - an
    // empty `requiredScopes.some(...)` in apiKeyAuth is always false and would 403
    // every key. Collapse it to undefined.
    requiredScopes: contract.scopes?.length ? [...contract.scopes] : undefined,
    ...baseOptions,
  });

  // A `jwtOnly` contract must REJECT API keys. baseApi always installs apiKeyAuth
  // (there is no key-less mode), so enforce it here: a request authenticated via an
  // API key (req.apiKeyInfo set by apiKeyAuth) is rejected. Without this, a jwtOnly
  // contract would silently accept any valid key while the spec publishes jwtAuth /
  // "API keys are NOT accepted" - the opposite of actual behaviour.
  if (contract.auth === 'jwtOnly') {
    router.use((req, _res, next) => {
      if (isApiKeyAuth(req)) {
        throw new UnauthorizedError('This endpoint accepts a JWT access token only; API keys are not accepted.');
      }
      next();
    });
  }

  // Rate limit runs BEFORE validation so a malformed body still counts against the
  // limiter (see the function-doc note on ordering).
  if (rateLimit) {
    router.use(rateLimit);
  }

  const requestSchema = contract.request;
  if (requestSchema) {
    router.use((req, _res, next) => {
      req.validated = requestSchema.parse(req.body) as RequestBodyOf<C>;
      next();
    });
  }

  // Non-prod safety net: warn if the handler emits a body that does not match the
  // contract's response schema for that status. Catches drift on inline-assembled
  // responses in tests/dev; compiled out of the hot path in production, warn-only,
  // and wrapped so it can never affect the actual response.
  if (process.env.NODE_ENV !== 'production' && Object.keys(contract.responses).length > 0) {
    router.use((req, res, next) => {
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        try {
          const spec = contract.responses[res.statusCode];
          const result = spec?.schema.safeParse(body);
          if (result && !result.success) {
            req.logger?.warn(
              `[contract] ${contract.operationId} response ${res.statusCode} violates schema: ${result.error.message}`
            );
          }
        } catch {
          // A dev assertion must never break the response.
        }
        return originalJson(body);
      }) as typeof res.json;
      next();
    });
  }

  return router;
}
