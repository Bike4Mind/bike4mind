import { Quest } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import {
  MCP_ACTION_REPLACED_ERROR_CODE,
  PENDING_ACTION_EXPIRED_ERROR_CODE,
  PENDING_ACTION_ALREADY_RESOLVED_ERROR_CODE,
} from '@bike4mind/common';
import { resolveMcpPendingAction, type PendingActionOutcome } from '@server/mcp/resolveMcpPendingAction';
import type { Logger } from '@bike4mind/observability';

type ActingUser = Parameters<typeof resolveMcpPendingAction>[0]['user'];

const LIFECYCLE_ERROR_CODES = {
  replaced: MCP_ACTION_REPLACED_ERROR_CODE,
  expired: PENDING_ACTION_EXPIRED_ERROR_CODE,
  already_resolved: PENDING_ACTION_ALREADY_RESOLVED_ERROR_CODE,
} as const;

/**
 * Shared body of the public approve and deny routes. The session id comes from the quest, never the
 * client, and ownership of that session is re-checked against the JWT user inside the resolver, so a
 * quest that is missing, malformed or someone else's answers the same 404. Lifecycle outcomes are
 * 409s with a stable `errorCode`; every other outcome keeps the status the web route gives it.
 */
export async function decidePendingAction({
  user,
  questId,
  pendingActionTs,
  confirmed,
  logger,
}: {
  user: ActingUser;
  questId: string;
  pendingActionTs: number;
  confirmed: boolean;
  logger: Logger;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const quest = isValidObjectId(questId) ? await Quest.findById(questId) : null;
  if (!quest?.sessionId) throw new NotFoundError('Pending action not found');

  const outcome: PendingActionOutcome = await resolveMcpPendingAction({
    user,
    questId,
    sessionId: quest.sessionId,
    confirmed,
    pendingActionTs,
    logger,
  });
  if (outcome.reason === 'not_found') throw new NotFoundError('Pending action not found');
  if (outcome.reason) {
    return {
      status: 409,
      body: { error: String(outcome.body.error), errorCode: LIFECYCLE_ERROR_CODES[outcome.reason] },
    };
  }
  if (outcome.status >= 500) return { status: outcome.status, body: { error: 'Failed to run the pending action' } };
  if (outcome.status >= 400) {
    const { success: _success, ...error } = outcome.body;
    return { status: outcome.status, body: error };
  }
  return outcome;
}
