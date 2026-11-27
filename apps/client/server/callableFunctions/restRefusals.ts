import { NotFoundError } from '@bike4mind/common';
import { findCallerFunction, type CallerFunction } from '@bike4mind/server-utils/callableFunctions/callerFunctions';
import { recordCallableFunctionRefusal } from '@bike4mind/server-utils/callableFunctions/dispatch';
import { FUNCTION_NOT_FOUND_MESSAGE } from '@server/callableFunctions/publicFunctions';

/** Stands in for an id that names no function of the caller's, so a row is never written against another's. */
export const UNSEEN_FUNCTION_ID = 'unknown';

interface RefusalContext {
  user: { id: string };
  apiKeyId?: string;
  logger: { warn: (message: string, context?: Record<string, unknown>) => void };
}

/**
 * The function a call names, by the caller's access: their own live one, or one shared with them, which the
 * dispatcher refuses with 403 until they review it. Any other id is written to the call log as a `refused` row,
 * as the MCP endpoint does, before the one 404 goes back. The row holds no inputs or outputs.
 */
export async function loadLiveFunctionForCall(id: string, ctx: RefusalContext): Promise<CallerFunction> {
  const lookup = await findCallerFunction(ctx.user, { id });
  if ('found' in lookup) return lookup.found;
  const request = {
    caller: { id: ctx.user.id },
    surface: 'rest' as const,
    ...(ctx.apiKeyId ? { apiKeyId: ctx.apiKeyId } : {}),
  };
  try {
    if (lookup.refused === 'not_live') {
      await recordCallableFunctionRefusal({ ...request, functionId: lookup.fn.id }, 'not_live', lookup.fn);
    } else {
      await recordCallableFunctionRefusal({ ...request, functionId: UNSEEN_FUNCTION_ID }, 'not_found');
    }
  } catch (recordError) {
    ctx.logger.warn('[functions] refusal row not written', { message: (recordError as Error).message });
  }
  throw new NotFoundError(FUNCTION_NOT_FOUND_MESSAGE);
}
