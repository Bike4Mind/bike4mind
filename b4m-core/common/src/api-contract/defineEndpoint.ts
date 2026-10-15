import type { z } from 'zod';
import type { EndpointContract, EndpointDeprecation } from './types';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Identity factory that pins an endpoint contract's type. The `const` type
 * parameter preserves the concrete request-schema type so downstream adapters
 * can infer the validated body type (`z.infer<contract['request']>`) rather than
 * collapsing to the `z.ZodTypeAny` constraint.
 *
 * Otherwise deliberately a no-op at runtime (no registry side effect, no
 * `.openapi()`) so a contract stays a plain, transport-agnostic value that any
 * runtime can import - the exceptions are the `pathParams`/`queryParams`
 * overlap check and the `deprecated` date check below, plain assertions with no
 * side effect of their own.
 */
export function defineEndpoint<const C extends EndpointContract<z.ZodTypeAny>>(contract: C): C {
  if (contract.pathParams && contract.queryParams) {
    // A `key in shape` check would also match Object.prototype names (`constructor`,
    // `toString`, ...) that queryParams never declared - build the query side's own
    // keys as a Set first, so only an actually-declared field name can overlap.
    const queryKeys = new Set(Object.keys(contract.queryParams.shape));
    const overlap = Object.keys(contract.pathParams.shape).filter(key => queryKeys.has(key));
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
  if (contract.deprecated) assertValidDeprecation(contract.operationId, contract.deprecated);
  return contract;
}

function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  // '2027-13-01' matches the shape but is not a calendar date, and toISOString() on an invalid
  // Date throws a bare RangeError before the tagged error below can name the operation.
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

// Both dates end up in HTTP headers and a published description; a typo there is a
// promise to API callers, so reject it at module load rather than ship it.
function assertValidDeprecation(operationId: string, { since, sunset }: EndpointDeprecation): void {
  if (!isIsoDate(since) || !isIsoDate(sunset)) {
    throw new Error(
      `defineEndpoint(${operationId}): deprecated.since and deprecated.sunset must be real YYYY-MM-DD dates, ` +
        `got ${JSON.stringify({ since, sunset })}.`
    );
  }
  if (sunset <= since) {
    throw new Error(`defineEndpoint(${operationId}): deprecated.sunset (${sunset}) must be after since (${since}).`);
  }
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
