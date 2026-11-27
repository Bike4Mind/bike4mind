import type { EventBridgeEvent } from 'aws-lambda';
import type { IStudioJobCompletedAction, StudioJobCompletedEvent } from '@bike4mind/common';
import { Connection } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { ClientMessageSender } from '@bike4mind/utils';
import { StudioEvents } from '@bike4mind/server-utils/utils/eventBus';
import { Resource } from 'sst';
import { withEventContext } from '@workers/utils/eventContext';

export type StudioJobCompletedRelay = (userId: string, action: IStudioJobCompletedAction) => Promise<void>;

/**
 * Relays one `studio.job.completed` event to the requester's open sessions, where the web client shows the
 * "takes ready" toast. A user with no open session gets nothing here; native push subscribes to the same event.
 * A malformed event is consumed, not thrown: redelivering it can never succeed.
 */
export async function relayStudioJobCompleted(
  detail: unknown,
  relay: StudioJobCompletedRelay,
  logger: Pick<Logger, 'warn' | 'updateMetadata'>
): Promise<void> {
  const parsed = StudioEvents.JobCompleted.schema.safeParse(detail);
  if (!parsed.success) {
    logger.warn('studio.job.completed event malformed; dropping', { reason: parsed.error.message });
    return;
  }
  const { userId, ...completion }: StudioJobCompletedEvent = parsed.data;
  logger.updateMetadata({ handler: 'studioJobCompleted', userId, groupId: completion.groupId });
  await relay(userId, { action: 'studio_job_completed', completion });
}

const handleWithContext = withEventContext(async (event, logger) => {
  const sender = new ClientMessageSender({ connections: Connection }, logger);
  await relayStudioJobCompleted(
    event.properties,
    (userId, action) => sender.sendToClient(userId, Resource.websocket.managementEndpoint, action),
    logger
  );
});

export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<void> => {
  await handleWithContext(event);
};
