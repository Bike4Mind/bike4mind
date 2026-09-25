import { baseApi } from './baseApi';
import type { EndpointContract, PathParamsOf, QueryParamsOf, RequestBodyOf } from '@bike4mind/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * EVERY registrar next-connect 0.13 exposes - patch all of them, not just the
 * common verbs, so none can register a terminal handler that bypasses the contract
 * prelude (validation + drift check). `.all`/`.head`/`.options`/`.trace` are here
 * too: they never match a single-method contract, so the verb guard below rejects
 * them, but they must still be wrapped or they'd slip a handler past validation.
 */
const METHODS = ['all', 'get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'trace'] as const;

/** Returns a copy of `obj` restricted to `keys`. */
function pick(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  // Object.hasOwn, not `k in obj`: the latter also matches inherited names
  // (`toString`, `constructor`, ...), which would report an absent key as
  // present - the same class of bug the defineEndpoint overlap guard fixed.
  return Object.fromEntries(keys.filter(k => Object.hasOwn(obj, k)).map(k => [k, obj[k]]));
}

/** Returns a copy of `obj` without `keys`. */
function omit(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const excluded = new Set(keys);
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !excluded.has(key)));
}

/**
 * Next.js transport adapter for an {@link EndpointContract}.
 *
 * Derives the route's auth mode + required scopes from the contract and validates
 * path params, query params, and the body against the contract schema (in that
 * order), exposing them to the handler as the typed `req.validatedParams` /
 * `req.validatedQuery` / `req.validated`. Returns the usual `baseApi` router, so
 * callers chain `.use(...)` / `.post(...)` exactly as before.
 *
 * Rate limiting is passed as `options.rateLimit` (rather than the caller chaining
 * its own `.use(...)`) so the adapter can order it correctly - auth -> rate limit
 * -> validation - as a hard guarantee: the limiter is prepended to the prelude, so
 * a flood of malformed bodies still counts against the limiter instead of 422ing
 * for free ahead of it.
 *
 * The SAME contract drives the OpenAPI spec (openapi/registerContract.ts):
 * define once, derive both.
 */
export function nextRouteForContract<C extends EndpointContract>(
  contract: C,
  options: { maxBodySize?: number; exemptReadsFromDailyRateLimit?: boolean; rateLimit?: RequestHandler } = {}
) {
  type ValidatedReq = Request & {
    validated: RequestBodyOf<C>;
    validatedParams: PathParamsOf<C>;
    validatedQuery: QueryParamsOf<C>;
  };
  type Handler = (req: ValidatedReq, res: Response, next: NextFunction) => unknown;

  const { rateLimit, ...baseOptions } = options;

  const router = baseApi<ValidatedReq, Response>({
    // 'jwtOnly' is enforced in baseApi by not installing the api-key chain at all,
    // so a key is never validated/metered/billed before being rejected.
    auth: contract.auth === 'public' ? false : contract.auth === 'jwtOnly' ? 'jwtOnly' : true,
    // Empty `scopes: []` means "no scope requirement", not "requires nothing" - an
    // empty `requiredScopes.some(...)` in apiKeyAuth is always false and would 403
    // every key. Collapse it to undefined.
    requiredScopes: contract.scopes?.length ? [...contract.scopes] : undefined,
    ...baseOptions,
  });

  const prelude: Handler[] = [];

  // Prepended first so it runs BEFORE validation: a malformed body still counts
  // against the limiter (see the function-doc note on ordering).
  if (rateLimit) {
    prelude.push(rateLimit as unknown as Handler);
  }

  // Path params are validated BEFORE the body: address the resource first, then
  // its payload. A request with both a bad id and a bad body should report the id
  // error, not bury it behind an unrelated body-validation failure.
  //
  // Next's file-based routing merges dynamic segments into req.query, not req.params
  // (there is no req.params in a Next.js API route) - see the pathParams doc comment.
  //
  // pathParams and queryParams are scoped ASYMMETRICALLY on purpose, not both the
  // same way:
  //   - pathParams is a fixed, closed set - only the `{name}` segments declared in
  //     `path` are ever populated by Next's routing, so it is picked down to
  //     exactly its own declared keys. Any other key in req.query (a real query
  //     string field, or the sibling schema's) is none of its business.
  //   - queryParams is inherently open - a caller can send any real query key - so
  //     it is scoped by omitting only the sibling pathParams's declared keys,
  //     never every undeclared key. That is what lets a `.strict()` queryParams
  //     schema still 422 a genuinely unexpected key, and a `.passthrough()` one
  //     still retain it, exactly as it would with no pathParams sibling at all.
  // Getting this backwards (pick-ing queryParams down to its own keys, or
  // omit-ing queryParams's keys off of pathParams) reintroduces the same
  // interference this split exists to prevent, just on the other schema.
  const pathParamsSchema = contract.pathParams;
  const queryParamsSchema = contract.queryParams;
  const pathParamsKeys = pathParamsSchema ? Object.keys(pathParamsSchema.shape) : [];

  if (pathParamsSchema) {
    prelude.push((req, _res, next) => {
      req.validatedParams = pathParamsSchema.parse(pick(req.query, pathParamsKeys)) as PathParamsOf<C>;
      next();
    });
  }

  // Real query-string fields, validated after path params but before the body -
  // same precedence reasoning: address/filter the resource before its payload.
  if (queryParamsSchema) {
    prelude.push((req, _res, next) => {
      req.validatedQuery = queryParamsSchema.parse(omit(req.query, pathParamsKeys)) as QueryParamsOf<C>;
      next();
    });
  }

  const requestSchema = contract.request;
  if (requestSchema) {
    prelude.push((req, _res, next) => {
      req.validated = requestSchema.parse(req.body) as RequestBodyOf<C>;
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
          // No schema => the contract declares a raw (non-JSON) body for this
          // status, so there is nothing to check.
          const result = spec?.schema?.safeParse(body);
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
  //     caller's own `.use(...)`, so a flood of malformed bodies would 422 without
  //     ever touching a caller-mounted limiter. Registering per method puts the
  //     prelude right before the terminal handler, so caller `.use(...)` middleware
  //     runs ahead of validation. (The `rateLimit` option instead lives at the FRONT
  //     of the prelude, so it beats validation without a caller having to remember the
  //     ordering.)
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
