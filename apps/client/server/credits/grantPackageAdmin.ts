import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';

export function toBadRequest(error: unknown): never {
  if (error instanceof z.ZodError) {
    throw new BadRequestError(error.issues.map(e => `${e.path.join('.') || 'value'}: ${e.message}`).join('; '));
  }
  throw error;
}

/** Splits the audit reason off the body so the strict package schema never sees it. */
export function splitReason(body: unknown): { rawReason: unknown; fields: unknown } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { rawReason: undefined, fields: body };
  const { reason: rawReason, ...fields } = body as Record<string, unknown>;
  return { rawReason, fields };
}
