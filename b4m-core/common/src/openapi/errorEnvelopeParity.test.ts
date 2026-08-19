import { describe, it, expect } from 'vitest';
import { getOpenApiMetadata } from '@asteasolutions/zod-to-openapi';
import { ErrorResponse } from './schemas';
import { ApiErrorSchema } from '../schemas/chat';

// Kept as a literal rather than read off the schema: the point is to fail when the
// published sunset changes, which reading it from the schema under test cannot do.
const NAME_SUNSET_DATE = '2026-12-01';

/**
 * `ErrorResponse` (the published component) and `ApiErrorSchema` (the plain, runtime-safe
 * twin) are two hand-maintained copies of one envelope, because the OpenAPI layer runs
 * extendZodWithOpenApi and so cannot be imported outside generation. Consumers that cannot
 * see the component - apps/client's errorHandler gate, most obviously - check themselves
 * against `ApiErrorSchema`, so a drift between the two silently weakens those gates.
 */
describe('the two copies of the error envelope agree', () => {
  it('declares the same fields in both', () => {
    expect(Object.keys(ErrorResponse.shape).sort()).toEqual(Object.keys(ApiErrorSchema.shape).sort());
  });

  it('agrees on which fields are optional', () => {
    for (const key of Object.keys(ApiErrorSchema.shape)) {
      const plain = ApiErrorSchema.shape[key as keyof typeof ApiErrorSchema.shape];
      const published = ErrorResponse.shape[key as keyof typeof ErrorResponse.shape];
      expect(published.safeParse(undefined).success).toBe(plain.safeParse(undefined).success);
    }
  });

  // Field-set parity alone would pass if someone dropped `deprecated: true` or the
  // sunset from the published description, which is the whole reason `name` is in the
  // spec at all - a plain documented field would promote an internal class name into
  // API we then owe compatibility on. See CONVENTIONS.md section 1.
  it('publishes `name` as deprecated with its sunset date', () => {
    const metadata = getOpenApiMetadata(ErrorResponse.shape.name);
    expect(metadata?.deprecated).toBe(true);
    expect(metadata?.description).toContain(NAME_SUNSET_DATE);
  });
});
