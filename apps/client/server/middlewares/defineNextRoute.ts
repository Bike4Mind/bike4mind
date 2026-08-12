import { baseApi } from './baseApi';
import type { EndpointContract, PathParamsOf, RequestBodyOf } from '@bike4mind/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * EVERY registrar next-connect 0.13 exposes - patch all of them, not just the
 * common verbs, so none can register a terminal handler that bypasses the contract
 * prelude (validation + drift check). `.all`/`.head`/`.options`/`.trace` are here
 * too: they never match a single-method contract, so the verb guard below rejects
 * them, but they must still be wrapped or they'd slip a handler past validation.
 */
const METHODS = ['all', 'get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'trace'] as const;

/**
 * Next.js transport adapter for an {@link EndpointContract}.
 *
 * Derives the route's auth mode + required scopes from the contract and validates
 * the body against the contract schema, exposing it to the handler as the typed
 * `req.validated`. Returns the usual `baseApi` router, so callers chain
 * `.use(...)` / `.post(...)` exactly as before.
 *
 * The SAME contract drives the OpenAPI spec (openapi/registerContract.ts):
 * define once, derive both.
 */
export function nextRouteForContract<C extends EndpointContract>(
  contract: C,
  options: { maxBodySize?: number; exemptReadsFromDailyRateLimit?: boolean } = {}
) {
  type ValidatedReq = Request & { validated: RequestBodyOf<C>; validatedParams: PathParamsOf<C> };
  type Handler = (req: ValidatedReq, res: Response, next: NextFunction) => unknown;

  const router = baseApi<ValidatedReq, Response>({
    // 'jwtOnly' is enforced in baseApi by not installing the api-key chain at all,
    // so a key is never validated/metered/billed before being rejected.
    auth: contract.auth === 'public' ? false : contract.auth === 'jwtOnly' ? 'jwtOnly' : true,
    // Empty `scopes: []` means "no scope requirement", not "requires nothing" - an
    // empty `requiredScopes.some(...)` in apiKeyAuth is always false and would 403
    // every key. Collapse it to undefined.
    requiredScopes: contract.scopes?.length ? [...contract.scopes] : undefined,
    ...options,
  });

  const prelude: Handler[] = [];

  const requestSchema = contract.request;
  if (requestSchema) {
    prelude.push((req, _res, next) => {
      req.validated = requestSchema.parse(req.body) as RequestBodyOf<C>;
      next();
    });
  }

  // Next's file-based routing merges dynamic segments into req.query, not req.params
  // (there is no req.params in a Next.js API route) - see the pathParams doc comment.
  const pathParamsSchema = contract.pathParams;
  if (pathParamsSchema) {
    prelude.push((req, _res, next) => {
      req.validatedParams = pathParamsSchema.parse(req.query) as PathParamsOf<C>;
      next();
    });
  }

  // Non-prod safety net: warn if the handler emits a body that does not match the
  // contract's response schema for that status. Catches drift on inline-assembled
  // responses in tests/dev; compiled out of the hot path in production, warn-only,
  // and wrapped so it can never affect the actual response.
  if (process.env.NODE_ENV !== 'production' && Object.keys(contract.responses).length > 0) {
    prelude.push((req, res, next) => {
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

  // The prelude is prepended to each METHOD REGISTRATION rather than installed with
  // `router.use(...)`. Two reasons:
  //
  //  1. Ordering. A construction-time `router.use(validate)` always runs ahead of the
  //     caller's own `.use(rateLimit(...))`, so a flood of malformed bodies would 422
  //     without ever touching the limiter. Registering per method puts validation
  //     right before the terminal handler, so the idiomatic `.use(rateLimit(...))
  //     .post(handler)` orders correctly with no special option to remember. NOTE:
  //     next-connect/Trouter still runs handlers in INSERTION order, so this is not a
  //     hard guarantee - `.post(handler).use(rateLimit(...))` (terminal handler mounted
  //     first) would still run the limiter after the handler. It just makes the correct
  //     order the natural one for the normal call shape.
  //  2. next-connect only falls through to its 404 when no non-`USE` handler matches
  //     the method. A `use`-mounted validator matches every method, so GET on a
  //     POST-only contract would 422 instead of 404.
  for (const method of METHODS) {
    const registrar = (router as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>)[method];
    // Some registrars may be absent depending on the next-connect version; skip those.
    if (typeof registrar !== 'function') continue;
    const register = registrar.bind(router) as (...handlers: unknown[]) => typeof router;
    // any: next-connect's registrars are overloaded on an optional leading path
    // pattern, which no single non-any signature can express for a generic
    // passthrough wrapper. Argument shape is preserved exactly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (router as any)[method] = (...args: unknown[]) => {
      // The registered verb MUST match the contract's declared method. Registering a
      // terminal handler on any other verb - including `.all`, which would serve every
      // method - runs the contract on a method it never declared. Fail loud rather than
      // validate the wrong verb (or, for the unwrapped-before verbs, bypass validation).
      if (method !== contract.method) {
        throw new Error(
          `nextRouteForContract(${contract.operationId}): handler registered via .${method}(), but the ` +
            `contract declares method '${contract.method}'. Register it with .${contract.method}().`
        );
      }
      const hasPattern = typeof args[0] === 'string' || args[0] instanceof RegExp;
      return hasPattern ? register(args[0], ...prelude, ...args.slice(1)) : register(...prelude, ...args);
    };
  }

  return router;
}
