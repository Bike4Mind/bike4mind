import { withEventContext } from '@server/events/utils';
import { SessionEvents } from '@server/utils/eventBus';
import {
  adminSettingsRepository,
  fabFileRepository,
  Quest,
  Session,
  sessionRepository,
  User,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { OperationsModelService } from '@client/services/operationsModelService';
import { AiEvents, ChatModelName, IMessage, KnowledgeType, SupportedFabFileMimeTypes } from '@bike4mind/common';
import { fabFilesService } from '@bike4mind/services';
import { getFilesStorage } from '@server/utils/storage';
import { logEvent } from '@server/utils/analyticsLog';

export const handler = withEventContext(async (event, logger) => {
  const body = SessionEvents.Summarize.schema.parse(event.properties);
  const { sessionId, userId, callTagging, trigger } = body;

  logger.updateMetadata({
    sessionId,
    userId,
    callTagging,
    trigger,
  });

  if (!sessionId) {
    logger.error(`Invalid message: ${body}`);
    return;
  }

  const session = await Session.findById(sessionId);
  if (!session) {
    logger.warn(`Record not found`);
    return;
  }

  const user = await User.findById(userId ?? session.userId);
  if (!user) {
    logger.error(`User not found`);
    return;
  }

  logger.info(`Handling summarization job for session ${sessionId} (as user ${userId ?? session.userId})`);

  const { modelId, llm, modelInfo } = await OperationsModelService.getOperationsModel();
  logger.info(`Using operations model for summarizing: ${modelInfo.name} (${modelInfo.backend})`);

  const modelHasChanged = session.summaryModelId && session.summaryModelId !== modelId;
  const needsInitialSummaryId = !session.summaryModelId;

  // Fetch quests created/updated since the last summary (up to 5)
  const quests = await Quest.find({
    sessionId: session.id,
    ...(session.summaryAt && !modelHasChanged && !needsInitialSummaryId
      ? {
          $or: [{ createdAt: { $gt: session.summaryAt } }, { updatedAt: { $gt: session.summaryAt } }],
        }
      : {}),
  })
    .sort({ timestamp: 1 })
    .limit(5);

  if (!quests?.length && !modelHasChanged && !needsInitialSummaryId) {
    logger.debug(`No latest quests to summarize for session ${sessionId}`);
    return;
  }

  // Ask the LLM to summarize (or extend the previous summary with) these quests
  logger.info(
    `Summarizing session ${session.id} based on quests ${quests.map(q => q._id).join(', ')} ${session.summary ? '(updating)' : '(new)'}`
  );

  const content = quests
    .map(quest =>
      [`Question: ${quest.prompt}`, `Answer: ${quest.reply || quest.replies?.join('\n') || 'No reply'}`].join('\n')
    )
    .join('\n');

  // Target summary length in words
  const summaryLength = [150, 300];

  const messages: IMessage[] = [
    {
      role: 'system',
      content:
        'Generate an abstract summary of this session as text' +
        (session.summary ? ' based on the previous summary and the following updates' : '.') +
        `  It should be between ${summaryLength.join('-')} words in length.`,
    },
  ];

  if (session.summary) {
    messages.push({
      role: 'system',
      content: `Previous summary:\n${session.summary}`,
    });
  }

  messages.push({
    role: 'user',
    content,
  });

  const options = {
    stream: false,
  };

  const completionBuffers: string[] = [];

  await llm.complete(modelId, messages, options, async (chunk: any[]) => {
    chunk.forEach((part: string | null | undefined, index: number) => {
      if (part === undefined || part === null) return;
      completionBuffers[index] = (completionBuffers[index] ?? '') + part;
    });
  });

  const summaryText = completionBuffers
    .map(text => text?.trim())
    .filter((text): text is string => Boolean(text))
    .join('\n');

  session.summary = summaryText;
  session.summaryAt = new Date();
  session.summaryModelId = modelId as ChatModelName;
  session.summaryTrigger = trigger;

  const summaryContent = session.summary;

  if (!summaryContent) {
    throw new Error(`Failed to generate summary for notebook ${session.id}`);
  }

  logger.info(`Summary: ${summaryContent}`);

  // Create a FabFile for the summary so we can chunk and vectorize it to be
  // used for RAG prompting
  const fabFileData = {
    userId: session.userId,
    fileName: `${session.name || 'Notebook'} Summary.txt`,
    fileContent: summaryContent,
    fileSize: Buffer.byteLength(summaryContent),
    mimeType: SupportedFabFileMimeTypes.TXT_PLAIN,
    isPublic: false,
    type: KnowledgeType.FILE,
    public: false,
    sessionId: session.id,
    tags: session.tags,
  };

  // Always persist the session summary first - this is the primary value.
  // FabFile creation (for RAG vectorization) is secondary and should not
  // block the summary from being saved.
  await sessionRepository.update({
    id: session.id,
    summary: session.summary,
    summaryAt: session.summaryAt,
    summaryModelId: session.summaryModelId,
  });

  // Attempt to create/update the FabFile for RAG indexing.
  // If this fails due to storage limits, log a warning but don't fail the
  // entire summarization - the summary text is already saved on the session.
  try {
    await withTransaction(async () => {
      const fabfile = await fabFileRepository.findOne({ sessionId: session.id });
      if (fabfile) {
        await fabFilesService.updateFabFile(
          user,
          {
            id: fabfile.id,
            fileName: fabFileData.fileName,
            mimeType: fabFileData.mimeType,
            type: fabFileData.type,
            fileContent: fabFileData.fileContent,
            sessionId: fabFileData.sessionId,
            tags: fabFileData.tags,
          },
          {
            db: {
              fabFiles: fabFileRepository,
            },
            storage: {
              upload: (filepath, content, options) => {
                return getFilesStorage().upload(content, filepath, {
                  ContentType: (options?.['ContentType'] as string) || 'text/plain',
                });
              },
              generateSignedUrl: (path: string, expireInSeconds: number) =>
                getFilesStorage().getSignedUrl(path, undefined, { expiresIn: expireInSeconds }),
            },
          }
        );
      } else {
        logger.info(`Creating Summary File`);
        const newFabFile = await fabFilesService.createFabFile(session.userId, fabFileData, {
          db: {
            fabFiles: fabFileRepository,
            adminSettings: adminSettingsRepository,
            users: userRepository,
          },
          storage: {
            upload: (filepath, content, option) => {
              const payload = content ?? '';
              return getFilesStorage().upload(payload, filepath, {
                ContentType: option?.ContentType || 'text/plain',
                ContentLength: option?.ContentLength ?? Buffer.byteLength(payload, 'utf8'),
              });
            },
            generateSignedUrl: (filepath: string, expireInSeconds: number) =>
              getFilesStorage().getSignedUrl(filepath, 'put', {
                expiresIn: expireInSeconds,
              }),
          },
        });

        if (!newFabFile.filePath) {
          throw new Error(`Failed to generate file path for notebook ${session.id} summary`);
        }

        await getFilesStorage().upload(summaryContent, newFabFile.filePath, { ContentType: newFabFile.mimeType });
      }
    });
  } catch (error) {
    const isStorageLimitError = error instanceof Error && error.message.includes('storage limit');
    if (isStorageLimitError) {
      logger.warn(
        `Storage limit exceeded for user ${user.id} — summary saved to session but FabFile not created for RAG indexing`
      );
    } else {
      throw error;
    }
  }

  // If requested, queue the tagging job now that the summary is generated
  if (callTagging) {
    await SessionEvents.Tag.publish({ sessionId: session.id });
  }

  await logEvent({ userId: user.id, type: AiEvents.NOTEBOOK_SUMMARIZATION, metadata: { sessionId } });
});
