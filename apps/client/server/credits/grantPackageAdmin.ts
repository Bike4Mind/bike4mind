import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { GRANT_PACKAGE_CAPS_CONFLICT_MESSAGE, grantPackageCapsConflict } from '@bike4mind/common';
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

/** Rejects a daily cap above the total cap (it could never bind). Pass the values as they will be stored. */
export function assertCapsConsistent(caps: { totalCap?: number | null; dailyCap?: number | null }): void {
  if (grantPackageCapsConflict(caps)) throw new BadRequestError(GRANT_PACKAGE_CAPS_CONFLICT_MESSAGE);
}
