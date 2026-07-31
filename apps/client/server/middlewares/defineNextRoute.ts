import { baseApi } from './baseApi';
import type { EndpointContract, RequestBodyOf } from '@bike4mind/common';
import type { Request, Response } from 'express';

/**
 * Next.js transport adapter for an {@link EndpointContract}.
 *
 * Derives the route's auth mode + required scopes from the contract and installs
 * a validation step that parses the body with the contract's request schema,
 * exposing it to the handler as the typed `req.validated`. The returned value is
 * the usual `baseApi` router, so callers chain `.use(...)` / `.post(...)` exactly
 * as before - only the auth + validation boilerplate is gone.
 *
 * The SAME contract drives the OpenAPI spec and the Lambda adapter
 * (server/cli/defineLambdaRoute.ts): define once, derive every transport.
 */
export function nextRouteForContract<C extends EndpointContract>(
  contract: C,
  options: { maxBodySize?: number; exemptReadsFromDailyRateLimit?: boolean } = {}
) {
  type ValidatedReq = Request & { validated: RequestBodyOf<C> };

  const router = baseApi<ValidatedReq, Response>({
    auth: contract.auth !== 'public',
    requiredScopes: contract.scopes ? [...contract.scopes] : undefined,
    ...options,
  });

  const requestSchema = contract.request;
  if (requestSchema) {
    // Validation runs as middleware (before the handler). A ZodError here is
    // caught by baseApi's errorHandler exactly as a `.parse()` in the handler
    // would be - same status mapping, one less line per handler.
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
