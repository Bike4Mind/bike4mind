import type { z } from 'zod';
import type { EndpointContract } from './types';

/**
 * Identity factory that pins an endpoint contract's type. The `const` type
 * parameter preserves the concrete request-schema type so downstream adapters
 * can infer the validated body type (`z.infer<contract['request']>`) rather than
 * collapsing to the `z.ZodTypeAny` constraint.
 *
 * It is deliberately a no-op at runtime (no registry side effect, no `.openapi()`)
 * so a contract stays a plain, transport-agnostic value that any runtime can import.
 */
export function defineEndpoint<const C extends EndpointContract<z.ZodTypeAny>>(contract: C): C {
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
