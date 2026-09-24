import type { z } from 'zod';
import type { EndpointContract } from './types';

/**
 * Identity factory that pins an endpoint contract's type. The `const` type
 * parameter preserves the concrete request-schema type so downstream adapters
 * can infer the validated body type (`z.infer<contract['request']>`) rather than
 * collapsing to the `z.ZodTypeAny` constraint.
 *
 * Otherwise deliberately a no-op at runtime (no registry side effect, no
 * `.openapi()`) so a contract stays a plain, transport-agnostic value that any
 * runtime can import - the one exception is the `pathParams`/`queryParams`
 * overlap check below, a plain assertion with no side effect of its own.
 */
export function defineEndpoint<const C extends EndpointContract<z.ZodTypeAny>>(contract: C): C {
  if (contract.pathParams && contract.queryParams) {
    const overlap = Object.keys(contract.pathParams.shape).filter(key => key in contract.queryParams!.shape);
    if (overlap.length > 0) {
      // Next merges the URL-template segment and the real query string into the
      // same req.query, keyed by name - see the pathParams/queryParams doc
      // comments in ./types.ts. A shared field name would let the path segment
      // silently win over the documented query value at runtime.
      throw new Error(
        `defineEndpoint(${contract.operationId}): pathParams and queryParams both declare ` +
          `${JSON.stringify(overlap)}. Next merges both into req.query by name, so the path segment ` +
          'would silently win over the query value. Rename one side.'
      );
    }
  }
  return contract;
}

/** The validated request-body type for a contract (or `unknown` if it has no body). */
export type RequestBodyOf<C extends EndpointContract> = C['request'] extends z.ZodTypeAny
  ? z.infer<C['request']>
  : unknown;

/** The validated path-params type for a contract (or `unknown` if it declares none). */
export type PathParamsOf<C extends EndpointContract> = C['pathParams'] extends z.ZodTypeAny
  ? z.infer<C['pathParams']>
  : unknown;

/** The validated query-params type for a contract (or `unknown` if it declares none). */
export type QueryParamsOf<C extends EndpointContract> = C['queryParams'] extends z.ZodTypeAny
  ? z.infer<C['queryParams']>
  : unknown;
