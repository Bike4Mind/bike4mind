import { withEventContext } from '@server/events/utils';
import { SessionEvents } from '@server/utils/eventBus';
import { questRepository, Session, sessionRepository } from '@bike4mind/database';
import { OperationsModelService } from '@client/services/operationsModelService';
import { sessionService } from '@bike4mind/services';

export const handler = withEventContext(async (event, logger) => {
  const { sessionId, userId } = SessionEvents.AutoName.schema.parse(event.properties);

  logger.updateMetadata({
    sessionId,
    userId,
  });

  logger.info(`Processing session auto-naming event for session ${sessionId}`);

  // Get the session to verify it exists
  const session = await Session.findById(sessionId);
  if (!session) {
    logger.warn(`Session ${sessionId} not found`);
    return;
  }

  // Skip if already auto-named, to prevent duplicate processing
  if (session.isAutoNamed) {
    logger.info('Session is already auto-named, skipping (duplicate prevention)', { sessionId });
    return;
  }

  // Additional check: If session name was recently updated, skip
  // Exclude placeholder names that should still be auto-renamed: the core
  // defaults, plus whatever placeholder a product surface stamped at create
  // (session.autoNamePlaceholder). A session the user has RENAMED no longer
  // matches its placeholder, so it keeps the recent-update protection below.
  const defaultNames = ['Untitled', 'New Notebook'];
  const hasPlaceholderName =
    defaultNames.includes(session.name) ||
    (session.autoNamePlaceholder != null && session.name === session.autoNamePlaceholder);
  if (session.updatedAt && session.name && !hasPlaceholderName) {
    const timeSinceLastUpdate = Date.now() - new Date(session.updatedAt).getTime();
    if (timeSinceLastUpdate < 10000) {
      // 10 seconds
      logger.info(
        'Session name was updated very recently, likely being processed by another handler, skipping (duplicate prevention)',
        {
          sessionId,
          timeSinceLastUpdateSec: Math.round(timeSinceLastUpdate / 1000),
        }
      );
      return;
    }
  }

  // Wrap in try/catch: auto-naming is a non-critical UX feature. LLM failures
  // (e.g. OpenAI 500s) must not cause a Lambda Invoke Error, so swallow and warn.
  let updatedSession;
  try {
    const { modelId, llm } = await OperationsModelService.getOperationsModel();
    logger.info(`Using operations model for auto-naming: ${modelId}`);

    updatedSession = await sessionService.autoName(
      { sessionId },
      {
        db: {
          sessions: sessionRepository,
          quests: questRepository,
        },
        createCompletion: async (prompt: string) => {
          let result = '';
          await llm.complete(
            modelId,
            [{ role: 'user', content: prompt }],
            { maxTokens: 600 },
            async (chunks: (string | null | undefined)[]) => {
              result += chunks.filter(Boolean).join('');
            }
          );

          const title = result.trim();
          if (!title) throw new Error('Failed to generate name');
          return title;
        },
        logger,
      }
    );
  } catch (error) {
    logger.warn(`Auto-naming failed for session ${sessionId} — skipping (non-critical)`, { error });
    return;
  }

  logger.info(`Successfully auto-named session ${sessionId} to "${updatedSession?.name}"`);
});
