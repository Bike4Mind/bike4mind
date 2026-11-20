import { initializeSlackPackage } from '@bike4mind/server-utils/integrations/slack/slackPackageInit';
initializeSlackPackage();

import { z } from 'zod';
import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import { resolveMcpPendingAction } from '@server/mcp/resolveMcpPendingAction';

const ConfirmRequestSchema = z.object({
  questId: z.string(),
  sessionId: z.string(),
  confirmed: z.boolean(),
  // The action the card displayed, so the click confirms exactly that action and never a newer one.
  pendingActionTs: z.number(),
});

/**
 * POST /api/mcp/confirm
 *
 * Handles web confirmation button clicks for MCP tool execution.
 * When user clicks Confirm or Cancel on a pending MCP action (e.g., GitHub issue creation).
 */
const handler = baseApi().post(async (req, res) => {
  const logger = new Logger({ metadata: { component: 'web-mcp-confirm' } });

  const parsed = ConfirmRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.error('[Web MCP Confirm] Invalid request body', { error: parsed.error });
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { questId, sessionId, confirmed, pendingActionTs } = parsed.data;
  const user = req.user;

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  logger.info('[Web MCP Confirm] Processing confirmation', {
    questId,
    sessionId,
    confirmed,
    userId: user.id,
  });

  const outcome = await resolveMcpPendingAction({ user, questId, sessionId, confirmed, pendingActionTs, logger });
  return res.status(outcome.status).json(outcome.body);
});

export default handler;
