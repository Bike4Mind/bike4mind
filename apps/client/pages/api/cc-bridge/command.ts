import { activeCodeAgentRepository } from '@bike4mind/database';
import { CcAgentCommandAction, CcAgentCommandPayload } from '@bike4mind/common';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/utils';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureTavernAccess } from '@server/utils/errors';
import { rateLimit } from '@server/middlewares/rateLimit';
import { sendToConnection } from '@server/websocket/utils';
import { randomUUID } from 'node:crypto';
import { Resource } from 'sst';
import { z } from 'zod';

/**
 * POST /api/cc-bridge/command
 *
 * Web HUD -> Server -> Bridge: dispatch a user command (prompt / permission
 * resolve / abort) to a specific live Claude Code agent. The bridge is the
 * sole tavern gateway (D14) - the server never talks directly to the engine,
 * it just forwards to the bridge's WS connection by looking up the
 * `ActiveCodeAgent` record for the given `instanceId`.
 *
 * Auth: standard session (user must own the instanceId).
 * Rate-limit: 60 commands / minute / user / path - plenty of headroom for
 * fast-clicking users, stops runaway browser loops.
 */

const RequestBody = z.object({
  instanceId: z.string().min(1).max(128),
  command: CcAgentCommandPayload,
});

const handler = baseApi({ auth: true })
  .use(rateLimit({ limit: 60, windowMs: 60_000 }))
  .post(
    asyncHandler(async (req, res) => {
      req.logger.updateMetadata({ endpoint: 'cc-bridge/command' });

      const userId = req.user?.id;
      if (!userId) throw new BadRequestError('Missing authenticated user');
      ensureTavernAccess(req.user);

      const parsed = RequestBody.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError(`Invalid command: ${parsed.error.message}`);
      }
      const { instanceId, command } = parsed.data;

      // Ownership + liveness check. `findByInstanceIdForUser` collapses the
      // "unknown" vs "not yours" timing side-channel into a single 404.
      const agent = await activeCodeAgentRepository.findByInstanceIdForUser(instanceId, userId);
      if (!agent) {
        throw new NotFoundError('Agent not found or not live');
      }

      // Capability gate - only dispatch commands to engines that advertise
      // `interactive`. Observer+ `claude` sessions can't accept commands.
      if (!agent.capabilities.includes('interactive')) {
        throw new ForbiddenError(
          `Agent ${instanceId} is read-only (source=${agent.source}); interactive commands not supported`
        );
      }

      const endpoint = Resource.websocket.managementEndpoint;
      const requestId = randomUUID();

      const action: z.infer<typeof CcAgentCommandAction> = {
        action: 'cc_agent_command',
        instanceId,
        requestId,
        command,
      };

      try {
        await sendToConnection(agent.connectionId, endpoint, action);
      } catch (err) {
        req.logger.error('[CC_BRIDGE_COMMAND] Failed to push to bridge:', err as Error);
        // The agent record looks live but the WS connection is gone.
        // Surface as 503 so the UI can retry rather than the misleading
        // 500 that a generic error would produce.
        return res.status(503).json({
          ok: false,
          requestId,
          error: 'Bridge connection unavailable; it may have just dropped',
        });
      }

      req.logger.info(
        `[CC_BRIDGE_COMMAND] User ${userId} dispatched ${command.type} to ${instanceId} (requestId=${requestId})`
      );

      return res.status(200).json({ ok: true, requestId });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
