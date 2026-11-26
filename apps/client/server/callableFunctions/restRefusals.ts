import { NotFoundError, type ICallableFunctionDetail } from '@bike4mind/common';
import { recordCallableFunctionRefusal } from '@bike4mind/server-utils/callableFunctions/dispatch';
import { loadLiveFunction } from '@server/callableFunctions/publicFunctions';

interface RefusalContext {
  user: { id: string };
  apiKeyId?: string;
  logger: { warn: (message: string, context?: Record<string, unknown>) => void };
}

/**
 * `loadLiveFunction` for a call: a function the caller cannot see is written to the call log as a `refused` row,
 * as the MCP endpoint does, before the same 404 goes back. The row holds no inputs or outputs.
 */
export async function loadLiveFunctionForCall(id: string, ctx: RefusalContext): Promise<ICallableFunctionDetail> {
  try {
    return await loadLiveFunction(ctx.user, id);
  } catch (error) {
    if (error instanceof NotFoundError) {
      try {
        await recordCallableFunctionRefusal(
          {
            caller: { id: ctx.user.id },
            functionId: id,
            surface: 'rest',
            ...(ctx.apiKeyId ? { apiKeyId: ctx.apiKeyId } : {}),
          },
          'not_found'
        );
      } catch (recordError) {
        ctx.logger.warn('[functions] refusal row not written', { message: (recordError as Error).message });
      }
    }
    throw error;
  }
}
