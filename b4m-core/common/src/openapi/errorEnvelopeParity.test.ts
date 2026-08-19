import { describe, it, expect } from 'vitest';
import { ErrorResponse } from './schemas';
import { ApiErrorSchema } from '../schemas/chat';

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
});
