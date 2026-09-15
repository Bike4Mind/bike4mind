import { activeCodeAgentRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureTavernAccess } from '@server/utils/errors';

/**
 * GET /api/cc-bridge/agents
 *
 * Returns the authenticated user's live Claude Code agent sessions. Used
 * by the client on tavern mount / refresh to replay `add_entity` scene
 * commands locally, since the server doesn't send state snapshots to new
 * WS connections.
 *
 * Stale filter (10 min since last heartbeat) is applied in the model's
 * `listForUser` query. The bridge heartbeats every 3 min so this gives
 * ≥3 cycles of headroom before a live-but-quiet session is hidden.
 */
const handler = baseApi({ auth: true }).get(
  asyncHandler(async (req, res) => {
    req.logger.updateMetadata({ endpoint: 'cc-bridge/agents' });

    const userId = req.user?.id;
    if (!userId) throw new BadRequestError('Missing authenticated user');
    ensureTavernAccess(req.user);

    const live = await activeCodeAgentRepository.listForUser(userId);

    return res.status(200).json({
      agents: live.map(a => ({
        instanceId: a.instanceId,
        deviceId: a.deviceId,
        workspaceName: a.workspaceName,
        workspacePath: a.workspacePath,
        spriteId: a.spriteId,
        position: a.position,
        status: a.status,
        source: a.source,
        capabilities: a.capabilities,
        lastSummary: a.lastSummary,
        startedAt: a.startedAt.toISOString(),
        lastEventAt: a.lastEventAt.toISOString(),
      })),
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
