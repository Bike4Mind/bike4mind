import { Connection, activityRepository } from '@bike4mind/database';
import {
  ISessionDocument,
  SessionEvents as AnalyticsSessionEvents,
  ProjectEvents,
  redactSessionForClient,
} from '@bike4mind/common';
import { ClientMessageSender } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { logEvent } from '@server/utils/analyticsLog';
import { ActivityType } from '@client/config/activities';
import { Ability } from '@server/auth/ability';
import { Resource } from 'sst';

/**
 * Observable side effects of session lifecycle/operations: WebSocket notifications,
 * analytics events, activity logging, and event publishing.
 *
 * These are fire-and-forget helpers composed by `sessionCrud` and `sessionOperations`.
 * They MUST NOT import from those modules - keeping the dependency one-directional
 * avoids circular imports. API routes should never call these directly.
 */

/**
 * Notifies connected clients that a new session was created via the management
 * WebSocket endpoint. Awaited by the caller so the notification is sent before returning.
 */
export async function notifySessionCreated(session: ISessionDocument, userId: string, logger: Logger): Promise<void> {
  const clientMessageSender = new ClientMessageSender(
    {
      connections: Connection,
    },
    logger
  );

  await clientMessageSender.sendToClient(userId, Resource.websocket.managementEndpoint, {
    action: 'session.created',
    // Strip server-owned fields (e.g. systemPromptText) before pushing over the WS - this
    // push fans out only to the owner's connections, but the field is never client-consumed
    // and is redacted on every other surface, so keep it off the wire here too
    ...redactSessionForClient(session),
    // Session schema has these as optional booleans; the WS message contract requires
    // concrete booleans, so default false when absent.
    isGlobalRead: session.isGlobalRead ?? false,
    isGlobalWrite: session.isGlobalWrite ?? false,
  });
}

/**
 * Records the analytics event for a newly created session.
 * Returns the in-flight promise so the caller can defer it as a background task.
 */
export function logSessionCreatedEvent(userId: string, session: ISessionDocument, ability?: Ability): Promise<void> {
  return logEvent(
    {
      userId,
      type: AnalyticsSessionEvents.CREATE_SESSION,
      metadata: {
        sessionId: session.id,
        sessionName: session.name,
        knowledgeIds: session.knowledgeIds ?? [],
        agentIds: session.agentIds ?? [],
      },
    },
    { ability }
  );
}

/**
 * Records the analytics event for a session being added to a project.
 * Returns the in-flight promise so the caller can defer it as a background task.
 */
export function logProjectSessionAddedEvent(
  userId: string,
  projectId: string,
  projectName: string,
  sessionId: string,
  ability?: Ability
): Promise<void> {
  return logEvent(
    {
      userId,
      type: ProjectEvents.ADD_SESSION,
      metadata: {
        projectId,
        projectName,
        contentId: sessionId,
        contentType: 'session',
      },
    },
    { ability }
  );
}

/**
 * Creates the activity record for a notebook added to a project.
 * Returns the in-flight promise so the caller can defer it as a background task.
 */
export function recordNotebookAddedToProjectActivity(projectId: string, userId: string): Promise<unknown> {
  return activityRepository.createActivity(
    ActivityType.NOTEBOOK_ADDED_TO_PROJECT,
    { type: 'Project', id: projectId },
    { type: 'User', id: userId }
  );
}

/**
 * Publishes a session-summarization request to EventBridge for async processing.
 */
export async function publishSummarizeSession(
  sessionId: string,
  trigger: ISessionDocument['summaryTrigger']
): Promise<void> {
  // Imported lazily to publish to EventBridge instead of SQS.
  const { SessionEvents } = await import('@server/utils/eventBus');
  await SessionEvents.Summarize.publish({
    sessionId,
    callTagging: true,
    trigger,
  });
}

/**
 * Publishes a context-summarization request to EventBridge for async processing.
 */
export async function publishContextSummarizeSession(
  sessionId: string,
  verbatimWindowStartQuestId: string
): Promise<void> {
  const { SessionEvents } = await import('@server/utils/eventBus');
  await SessionEvents.ContextSummarize.publish({ sessionId, verbatimWindowStartQuestId });
}
