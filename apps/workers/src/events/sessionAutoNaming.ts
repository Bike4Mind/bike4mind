import { withEventContext } from '@workers/utils/eventContext';
import { SessionEvents } from '@bike4mind/server-utils/utils/eventBus';
import { fabFileRepository, questRepository, Session, sessionRepository, userRepository } from '@bike4mind/database';
import { OperationsModelService } from '@bike4mind/server-utils/services/operationsModelService';
import { sessionService } from '@bike4mind/services';
import type { CompletionInfo } from '@bike4mind/llm-adapters';
import { recordSessionOperationalUsage } from '@workers/events/recordSessionOperationalUsage';
import { payerCanFundSessionOperation } from '@workers/events/sessionOperationalCreditGate';
import { aiAccessDeniedMessage } from '@bike4mind/services/userService/accountState';
import { hasAutoNamePlaceholderName } from '@bike4mind/common';

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
  // Placeholder names (see hasAutoNamePlaceholderName) are exempt so they still get named. A
  // session the user has RENAMED no longer matches its placeholder, so it keeps this protection.
  if (session.updatedAt && session.name && !hasAutoNamePlaceholderName(session)) {
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

  const user = await userRepository.findById(userId ?? session.userId);
  if (!user || aiAccessDeniedMessage(user)) {
    logger.warn(`Skipping auto-naming for session ${sessionId}: user missing or AI access held`);
    return;
  }

  if (!(await payerCanFundSessionOperation({ payerId: user.id, operation: 'session auto-naming', logger }))) return;

  // Wrap in try/catch: auto-naming is a non-critical UX feature. LLM failures
  // (e.g. OpenAI 500s) must not cause a Lambda Invoke Error, so swallow and warn.
  let updatedSession;
  let lastCompletionInfo: CompletionInfo | undefined;
  const startTime = Date.now();
  try {
    const { modelId, llm, modelInfo } = await OperationsModelService.getOperationsModel();
    logger.info(`Using operations model for auto-naming: ${modelId}`);

    updatedSession = await sessionService.autoName(
      { sessionId },
      {
        db: {
          sessions: sessionRepository,
          quests: questRepository,
          files: fabFileRepository,
          fileAccess: { userId: user.id, userGroups: user.groups ?? undefined },
        },
        createCompletion: async (prompt: string) => {
          let result = '';
          await llm.complete(
            modelId,
            [{ role: 'user', content: prompt }],
            { maxTokens: 600 },
            async (chunks: (string | null | undefined)[], completionInfo?: CompletionInfo) => {
              result += chunks.filter(Boolean).join('');
              if (completionInfo) lastCompletionInfo = completionInfo;
            }
          );

          const title = result.trim();
          if (!title) throw new Error('Failed to generate name');
          return title;
        },
        logger,
      }
    );

    await recordSessionOperationalUsage({
      operation: 'notebook_naming',
      userId,
      sessionId,
      modelId,
      modelInfo,
      completionInfo: lastCompletionInfo,
      startTime,
      logger,
    });
  } catch (error) {
    logger.warn(`Auto-naming failed for session ${sessionId} — skipping (non-critical)`, { error });
    return;
  }

  logger.info(`Successfully auto-named session ${sessionId} to "${updatedSession?.name}"`);
});
