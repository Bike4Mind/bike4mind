import type { Response } from 'express';
import type { z } from 'zod';
import { InternalServerError } from '@bike4mind/common';

/**
 * Typed response boundary (RFC #483). Parses `data` through `schema` before
 * `res.json`, giving every endpoint an explicit, machine-checked response contract:
 *
 *  - Fields not in the schema are STRIPPED (Zod's default object behavior), so
 *    accidental over-exposure of a raw ORM document is structurally impossible
 *    rather than dependent on someone remembering to sanitize.
 *  - A shape/type mismatch fails loud as an opaque 500. A response-boundary
 *    violation is OUR bug (the handler produced the wrong shape), not client-fixable
 *    input -- so it must NOT take errorHandler's request-validation ZodError path,
 *    which returns 422 and echoes the offending field detail to the client. We throw
 *    an InternalServerError with a generic message and carry the ZodError as `cause`
 *    so it's logged server-side (errorHandler logs the full error at 5xx) without
 *    leaking internal response shape to the caller.
 *
 * `data` is the pre-serialization object handed to `res.json`, so Date instances
 * are still Dates; response schemas model that (`z.date()`) and `res.json` does the
 * Date -> ISO-string conversion afterwards.
 */
export function respond<T extends z.ZodTypeAny>(res: Response, schema: T, data: unknown, status = 200): Response {
  const result = schema.safeParse(data);
  if (!result.success) {
    const error = new InternalServerError('Response validation failed');
    error.cause = result.error;
    throw error;
  }
  return res.status(status).json(result.data);
}
