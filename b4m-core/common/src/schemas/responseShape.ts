import * as z from 'zod';

/**
 * Building blocks for entity response schemas held to an entity's key list (see
 * selfUserResponseSchema in ./user.ts for the full rationale). A passthrough value is
 * `z.unknown()`: the boundary enforces WHICH keys leave the server, not their types, so a
 * legacy value on a long-lived Mongo document can never 500 a read.
 */
export const passthroughField = z.unknown().optional();

export function passthroughShape<K extends string>(fields: Record<K, true>): Record<K, typeof passthroughField> {
  return Object.fromEntries(Object.keys(fields).map(field => [field, passthroughField])) as Record<
    K,
    typeof passthroughField
  >;
}
