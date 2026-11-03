import type { EventBridgeEvent } from 'aws-lambda';
import type { Logger } from '@bike4mind/observability';
import { handler as createMementoHandler } from '@workers/events/createMemento';
import { handler as sessionAutoNamingHandler } from '@workers/events/sessionAutoNaming';
import { handler as sessionSummarizationHandler } from '@workers/events/sessionSummarization';
import { handler as sessionContextSummarizationHandler } from '@workers/events/sessionContextSummarization';
import { handler as sessionTaggingHandler } from '@workers/events/sessionTagging';
import { handler as notebookCurationHandler } from '@workers/events/notebookCuration';
import { requestRiskEvidenceRefresh } from '@server/auth/riskEvidence';

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

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

// Mirrors the hosted rule that also routes completion.completed to riskEvidenceQueue. The refresh never
// throws, so it cannot block memento creation.
const completionCompletedHandler: EventHandler = async event => {
  const detail: unknown = event.detail;
  const userId = typeof detail === 'object' && detail !== null && 'userId' in detail ? detail.userId : undefined;
  if (typeof userId === 'string' && OBJECT_ID_PATTERN.test(userId)) {
    await requestRiskEvidenceRefresh(userId, 'completion', console);
  }
  await createMementoHandler(event);
};

const HANDLERS: Record<string, EventHandler> = {
  'completion.completed': completionCompletedHandler,
  'session.auto_name': sessionAutoNamingHandler,
  'session.summarize': sessionSummarizationHandler,
  'session.context_summarize': sessionContextSummarizationHandler,
  'session.tag': sessionTaggingHandler,
  'notebook.curation.start': notebookCurationHandler,
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
