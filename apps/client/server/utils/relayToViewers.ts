import type { IMessageDataToClient } from '@bike4mind/common';
import { agentExecutionRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { isGoneError } from '@bike4mind/server-utils/websocket/goneError';
import { sendToConnection } from '@bike4mind/server-utils/websocket/utils';
import { Resource } from 'sst';

/**
 * Sends `frames`, in order, to every connection watching `executionId` (the WS `subscribe` command), for
 * a run no executor streams: a desktop loop run. Drops a gone viewer; best effort, never throws.
 * Frame shapes must stay in sync with createWsSender (apps/workers/src/queueHandlers/agentExecutor.ts).
 */
export async function relayToViewers(executionId: string, frames: IMessageDataToClient[], logger: Logger) {
  if (frames.length === 0) return;
  try {
    const viewers = await agentExecutionRepository.findViewerConnectionIds(executionId);
    if (viewers.length === 0) return;
    const endpoint = Resource.websocket.managementEndpoint;
    await Promise.all(
      viewers.map(async connectionId => {
        for (const frame of frames) {
          try {
            await sendToConnection(connectionId, endpoint, frame);
          } catch (error) {
            if (isGoneError(error)) {
              await agentExecutionRepository.removeViewer(executionId, connectionId).catch(() => {});
              return;
            }
            logger.warn(`[Loops] Could not relay ${frame.action} to ${connectionId}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      })
    );
  } catch (error) {
    logger.warn(`[Loops] Relay to the viewers of ${executionId} failed`, { error });
  }
}
