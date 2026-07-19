import type { EventBridgeEvent } from 'aws-lambda';
import type { Logger } from '@bike4mind/observability';
import { handler as createMementoHandler } from '@server/events/createMemento';
import { handler as sessionAutoNamingHandler } from '@server/events/sessionAutoNaming';
import { handler as sessionSummarizationHandler } from '@server/events/sessionSummarization';
import { handler as sessionContextSummarizationHandler } from '@server/events/sessionContextSummarization';
import { handler as sessionTaggingHandler } from '@server/events/sessionTagging';

/**
 * Self-host event routing.
 *
 * eventBus.publishSelfHost enqueues non-email events to SELF_HOST_EVENT_QUEUE as
 * `{ detailType, detail }`. This table maps each detailType to the SAME hosted event
 * handler the cloud EventBridge rules invoke, so enrichment (memento creation, session
 * auto-naming, summaries, tagging) runs identically in self-host. Handlers are
 * withEventContext-wrapped and connect to Mongo themselves.
 *
 * detail-types with no entry here are logged at debug and treated as handled: most
 * published events (progress/telemetry/etc.) have no self-host consumer by design.
 */
type EventHandler = (event: EventBridgeEvent<string, unknown>) => Promise<void>;

const HANDLERS: Record<string, EventHandler> = {
  'completion.completed': createMementoHandler,
  'session.auto_name': sessionAutoNamingHandler,
  'session.summarize': sessionSummarizationHandler,
  'session.context_summarize': sessionContextSummarizationHandler,
  'session.tag': sessionTaggingHandler,
};

export async function dispatchSelfHostEvent(
  detailType: string,
  detail: unknown,
  logger?: Pick<Logger, 'debug'>
): Promise<void> {
  const handler = HANDLERS[detailType];
  if (!handler) {
    logger?.debug(`[eventDispatch] no self-host handler for "${detailType}"; ignoring`);
    return;
  }

  // Minimal EventBridge envelope; withEventContext only reads detail-type and detail.
  const event: EventBridgeEvent<string, unknown> = {
    version: '0',
    id: '',
    'detail-type': detailType,
    source: 'selfHostWorker',
    account: '',
    time: new Date().toISOString(),
    region: process.env.AWS_REGION ?? 'us-east-2',
    resources: [],
    detail,
  };

  await handler(event);
}
