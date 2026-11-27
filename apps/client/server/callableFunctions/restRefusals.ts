import { NotFoundError, type ICallableFunctionDetail } from '@bike4mind/common';
import { callableFunctionRepository } from '@bike4mind/database';
import { recordCallableFunctionRefusal } from '@bike4mind/server-utils/callableFunctions/dispatch';
import { loadLiveFunction } from '@server/callableFunctions/publicFunctions';

/** Stands in for an id that names no function of the caller's, so a row is never written against another's. */
export const UNSEEN_FUNCTION_ID = 'unknown';

interface RefusalContext {
  user: { id: string };
  apiKeyId?: string;
  logger: { warn: (message: string, context?: Record<string, unknown>) => void };
}

/**
 * `loadLiveFunction` for a call: a refusal is written to the call log as a `refused` row, as the MCP endpoint
 * does, before the same 404 goes back. The row holds no inputs or outputs.
 */
export async function loadLiveFunctionForCall(id: string, ctx: RefusalContext): Promise<ICallableFunctionDetail> {
  try {
    return await loadLiveFunction(ctx.user, id);
  } catch (error) {
    if (error instanceof NotFoundError) {
      const request = {
        caller: { id: ctx.user.id },
        surface: 'rest' as const,
        ...(ctx.apiKeyId ? { apiKeyId: ctx.apiKeyId } : {}),
      };
      try {
        const own = await callableFunctionRepository.findByIdForOwner(id, { ownerType: 'user', ownerKey: ctx.user.id });
        if (own) await recordCallableFunctionRefusal({ ...request, functionId: own.id }, 'not_live', own);
        else await recordCallableFunctionRefusal({ ...request, functionId: UNSEEN_FUNCTION_ID }, 'not_found');
      } catch (recordError) {
        ctx.logger.warn('[functions] refusal row not written', { message: (recordError as Error).message });
      }
    }
    throw error;
  }
}
