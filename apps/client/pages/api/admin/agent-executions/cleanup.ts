import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin, BadRequestError } from '@server/utils/errors';
import { agentExecutionRepository } from '@bike4mind/database';
import { Connection } from '@bike4mind/database/social';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { Resource } from 'sst';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

const MAX_IDS_PER_REQUEST = 500;

const BodySchema = z.object({
  executionIds: z.array(z.string().min(1)).min(1).max(MAX_IDS_PER_REQUEST),
});

export type CleanupResponse = {
  requested: number;
  marked: number;
  notifiedConnections: number;
};

/**
 * POST /api/admin/agent-executions/cleanup
 *
 * Transitions the given executions to `failed` + `failureReason: 'abandoned'`
 * and best-effort emits a `failed` WS event to every open connection of each
 * owning user (so a still-mounted UI updates immediately). Executions that
 * have already reached a terminal state are no-ops. `markAbandoned` filters
 * to sweepable statuses to avoid clobbering a concurrent natural completion.
 */
const handler = baseApi().post(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid request body');
  }
  const { executionIds } = parsed.data;
  const adminUserId = req.user?.id;

  const swept = await agentExecutionRepository.markAbandoned(executionIds);

  Logger.info('[AgentExecutionsCleanup] Marked abandoned', {
    adminUserId,
    requested: executionIds.length,
    marked: swept.length,
  });

  // Best-effort notify every open connection of each affected user. Sends are
  // parallel so a noisy fleet doesn't wedge the admin request behind dozens
  // of sequential API Gateway round-trips. Stale connectionIds raise
  // GoneException - we count failures rather than re-throwing.
  let notified = 0;
  if (swept.length > 0) {
    const endpoint = Resource.websocket.managementEndpoint;
    const client = new ApiGatewayManagementApiClient({ endpoint });
    const byUserId = swept.reduce<Record<string, string[]>>((acc, { userId, id }) => {
      (acc[userId] ??= []).push(id);
      return acc;
    }, {});

    const userIds = Object.keys(byUserId);
    const connectionsByUser = await Promise.all(userIds.map(userId => Connection.findByUserId(userId).catch(() => [])));

    const sends: Array<{ connectionId: string; executionId: string }> = [];
    userIds.forEach((userId, idx) => {
      const ids = byUserId[userId] ?? [];
      for (const conn of connectionsByUser[idx] ?? []) {
        for (const executionId of ids) {
          sends.push({ connectionId: conn.connectionId, executionId });
        }
      }
    });

    const results = await Promise.allSettled(
      sends.map(({ connectionId, executionId }) =>
        client.send(
          new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: Buffer.from(JSON.stringify({ action: 'failed', executionId, reason: 'abandoned' })),
          })
        )
      )
    );

    results.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        notified++;
      } else {
        Logger.warn('[AgentExecutionsCleanup] WS notify failed', {
          connectionId: sends[idx]?.connectionId,
          executionId: sends[idx]?.executionId,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
  }

  const body: CleanupResponse = {
    requested: executionIds.length,
    marked: swept.length,
    notifiedConnections: notified,
  };
  return res.json(body);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
