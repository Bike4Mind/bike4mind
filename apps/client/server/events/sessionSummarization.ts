import { withEventContext } from '@server/events/utils';
import { SessionEvents } from '@server/utils/eventBus';
import {
  adminSettingsRepository,
  dataLakeRepository,
  fabFileRepository,
  Quest,
  Session,
  sessionRepository,
  User,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { OperationsModelService } from '@client/services/operationsModelService';
import {
  AiEvents,
  ChatModelName,
  DATALAKE_TAG_PREFIX,
  IMessage,
  KnowledgeType,
  prefixArmTagNames,
  SupportedFabFileMimeTypes,
} from '@bike4mind/common';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import { getFilesStorage } from '@server/utils/storage';
import { logEvent } from '@server/utils/analyticsLog';
import type { CompletionInfo } from '@bike4mind/llm-adapters';
import { recordSessionOperationalUsage } from '@server/events/recordSessionOperationalUsage';

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

  // Everything downstream keys off the session's owner: it is the conjunct that stops the
  // summary-file lookup selecting someone else's document, and the owner createFabFile stamps.
  // Mongoose drops an undefined value from a filter, so an owner-less session would silently
  // restore the unscoped lookup - and the acting user comes from the event on the spider and
  // agent-run paths, so the `!user` check below does not catch it.
  if (!session.userId) {
    logger.warn(`Session ${sessionId} has no owner; skipping summarization`);
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
  let lastCompletionInfo: CompletionInfo | undefined;
  const completionStartTime = Date.now();

  await llm.complete(modelId, messages, options, async (chunk: any[], completionInfo?: CompletionInfo) => {
    chunk.forEach((part: string | null | undefined, index: number) => {
      if (part === undefined || part === null) return;
      completionBuffers[index] = (completionBuffers[index] ?? '') + part;
    });
    if (completionInfo) lastCompletionInfo = completionInfo;
  });

  await recordSessionOperationalUsage({
    user,
    sessionId,
    modelId,
    modelInfo,
    completionInfo: lastCompletionInfo,
    startTime: completionStartTime,
    logger,
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
      // The owner conjunct is load-bearing: a sessionId is not an ownership claim (any user can
      // stamp one on their own file via PUT /api/files/[id]) and updateFabFile below gates on
      // findAccessibleById, which a read share satisfies. Without it, a file merely shared with
      // the summarizing user gets its content and tags overwritten with this summary. A miss
      // falls through to createFabFile - a duplicate beats clobbering someone else's file.
      const fabfile = await fabFileRepository.findOne({ sessionId: session.id, userId: session.userId });
      if (fabfile) {
        // Re-summarizing must not change which data lakes this file belongs to. The tags here are
        // the SESSION's, which are not expected to carry a `datalake:` meta-tag or a prefix-arm
        // content tag, and a whole-array tag write omitting one reads as leaving that lake - so
        // without carrying the file's existing membership tags through, every re-summarization
        // would evict a lake-indexed summary (and fail outright for a summariser who cannot
        // manage the lake). `lakeTags` below drops anything already present in the session's own
        // tags, so an overlap (an unusual case, not the norm described above) still can't produce
        // a duplicate entry in the persisted array.
        //
        // Carries BOTH signals: the meta-tag, and any tag under a prefix arm the file's OWNER
        // (session.userId - this query is anchored to it above) runs. Since #1263, a prefix tag
        // alone is membership too, and reconcileLakeTags now gates its loss the same as a
        // meta-tag's - this file must round-trip both or a re-summarization silently (or, for a
        // non-managing summariser, loudly) evicts it.
        //
        // reconcileLakeTags may stamp a content tag for one of these lakes if this file lacks
        // one - never a NEW membership, since `lakeTags` only ever carries through tags already
        // stored on the file. Harmless either way: this FabFile always carries a sessionId,
        // which both tag counters exclude unless it is a curated notebook, so a stamp here could
        // never reach the tag tree.
        const storedTagNames = (fabfile.tags ?? [])
          .map(t => t?.name)
          .filter((name): name is string => typeof name === 'string');
        // Short-circuits the query when nothing stored could carry a prefix arm - every usable
        // prefix ends in ':' (see `prefixArmTagNames`), and a meta-tag never matches one. Mirrors
        // the guard `reconcileLakeTags`, `toggleTags`, and the bulk tag doors all use.
        const couldCarryPrefixArm = storedTagNames.some(
          name => !name.toLowerCase().startsWith(DATALAKE_TAG_PREFIX) && name.includes(':')
        );
        const prefixArmLakes = couldCarryPrefixArm
          ? await dataLakeService.loadPrefixArmCandidateLakes([fabfile.userId], {
              db: { dataLakes: dataLakeRepository },
            })
          : [];
        // Computed once, not per tag: prefixArmTagNames re-scans the whole tag list per lake, so
        // calling it inside the filter below would redo that scan for every tag on the file.
        const prefixArmSignalNames = new Set(
          prefixArmLakes.flatMap(lake => prefixArmTagNames(storedTagNames, lake.fileTagPrefix))
        );
        const sessionTagNames = new Set((fabFileData.tags ?? []).map(t => t.name));
        const lakeTags = (fabfile.tags ?? []).filter(t => {
          if (typeof t?.name !== 'string') return false;
          if (sessionTagNames.has(t.name)) return false;
          if (t.name.toLowerCase().startsWith(DATALAKE_TAG_PREFIX)) return true;
          // prefixArmLakes is already scoped to fabfile.userId (the $in query above), so no
          // further owner check is needed here.
          return prefixArmSignalNames.has(t.name);
        });
        await fabFilesService.updateFabFile(
          user,
          {
            id: fabfile.id,
            fileName: fabFileData.fileName,
            mimeType: fabFileData.mimeType,
            type: fabFileData.type,
            fileContent: fabFileData.fileContent,
            sessionId: fabFileData.sessionId,
            tags: [...(fabFileData.tags ?? []), ...lakeTags],
          },
          {
            db: {
              fabFiles: fabFileRepository,
              dataLakes: dataLakeRepository,
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
        // A session's tags are carried forward, not a fresh self-tag action - #1101 asks that this
        // path not SILENTLY join a lake, not that one stale/unmanageable datalake: tag (from before
        // the session's user lost access, or was never granted it) takes the whole summary down.
        // createFabFile's gate now refuses such a tag outright, so drop it here first and log it;
        // the summary is the primary value this handler exists to preserve.
        const sessionMetaTagNames = new Set(
          dataLakeService.extractDataLakeMetaTags((fabFileData.tags ?? []).map(t => t.name))
        );
        const unmanageableMetaTags: string[] = [];
        for (const tag of sessionMetaTagNames) {
          const lake = await dataLakeRepository.findByDatalakeTag(tag);
          if (!lake || !dataLakeService.canManageLake(lake, { userId: session.userId, isAdmin: !!user?.isAdmin })) {
            unmanageableMetaTags.push(tag);
          }
        }
        if (unmanageableMetaTags.length > 0) {
          logger.warn(
            `Dropping unmanageable data-lake tag(s) from session ${session.id} summary: ${unmanageableMetaTags.join(', ')}`
          );
          fabFileData.tags = (fabFileData.tags ?? []).filter(t => !unmanageableMetaTags.includes(t.name.toLowerCase()));
        }
        const newFabFile = await fabFilesService.createFabFile(session.userId, fabFileData, {
          db: {
            fabFiles: fabFileRepository,
            adminSettings: adminSettingsRepository,
            users: userRepository,
            dataLakes: dataLakeRepository,
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
