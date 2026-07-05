import {
  Session,
  User,
  NotebookCurationJob,
  sessionRepository,
  questRepository,
  fabFileRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import { secureParameters } from '@bike4mind/utils';
import { notebookCurationService } from '@bike4mind/services';
import { CurationOptions } from '@bike4mind/common';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { sendToClient } from '@server/websocket/utils';
import { NotebookCurationEvents } from '@server/utils/eventBus';
import { getFilesStorage } from '@server/utils/storage';
import { z } from 'zod';
import { Resource } from 'sst';

export const CurateNotebookPayload = z.object({
  sessionId: z.string(),
  userId: z.string(),
  curationJobId: z.string(),
  batchJobId: z.string().optional(),
  batchIndex: z.number().optional(),
  batchTotal: z.number().optional(),
  curationType: z.enum(['transcript', 'executive_summary']).optional(),
  artifactTypes: z
    .array(
      z.enum(['CODE', 'REACT', 'MERMAID', 'RECHARTS', 'SVG', 'HTML', 'QUESTMASTER_PLAN', 'DEEP_RESEARCH', 'IMAGE'])
    )
    .optional(),
  exportFormat: z.enum(['markdown', 'txt', 'html']).optional(),
  customNotebookName: z.string().optional(),
});

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body = event.Records[0].body;
  const {
    userId,
    sessionId,
    curationJobId,
    batchJobId,
    batchIndex,
    batchTotal,
    curationType,
    artifactTypes,
    exportFormat,
    customNotebookName,
  } = secureParameters(JSON.parse(body), CurateNotebookPayload);

  logger.updateMetadata({
    sessionId,
    userId,
    curationJobId,
    batchJobId: batchJobId || 'none',
    batchIndex: batchIndex ?? -1,
    batchTotal: batchTotal ?? 1,
  });

  if (!sessionId || !curationJobId) {
    logger.error(`Invalid message: ${body}`);
    return;
  }

  // Idempotency guard: SQS is at-least-once, so a redelivered
  // message must not re-run the LLM curation. If this curationJobId already
  // completed, this is a duplicate delivery - skip it (and do not re-broadcast
  // websocket events, to avoid double-counting in the UI). Only successful
  // completions are recorded; failures stay retryable via SQS's native
  // retry/DLQ machinery, so they are not guarded here.
  const existingJob = await NotebookCurationJob.findOne({ curationJobId }).lean();
  if (existingJob && existingJob.status === 'completed') {
    logger.info(
      `Duplicate SQS message, skipping — curation job ${curationJobId} already completed for session ${sessionId}`
    );
    return;
  }

  const session = await Session.findById(sessionId);
  if (!session) {
    logger.warn(`Session ${sessionId} not found`);
    return;
  }

  const user = await User.findById(userId ?? session.userId);
  if (!user) {
    logger.error(`User not found`);
    return;
  }

  const batchInfo = batchJobId ? ` [Batch ${batchIndex! + 1}/${batchTotal}]` : '';
  logger.info(
    `Starting notebook curation for session ${sessionId}${batchInfo} (job: ${curationJobId}, type: ${curationType || 'transcript'})`
  );

  const websocketEndpoint = Resource.websocket.managementEndpoint;

  try {
    // Create LLM service adapter if executive summary is requested
    let llmService: any = undefined;
    let llmModelId: string | undefined = undefined;
    if (curationType === 'executive_summary') {
      logger.info('Initializing LLM service for executive summary generation...');
      try {
        // Get operations model with initialized LLM backend
        const { OperationsModelService } = await import('@client/services/operationsModelService');
        const { llm, modelInfo } = await OperationsModelService.getOperationsModel();

        // Create adapter that matches the LLMContext interface
        llmService = {
          complete: llm.complete.bind(llm),
        };

        // Store the model ID to pass to the curation service
        llmModelId = modelInfo.id;

        logger.info(
          `Created LLM service adapter for executive summary generation using ${modelInfo.name} (${modelInfo.id}, backend: ${modelInfo.backend})`
        );
      } catch (llmError) {
        logger.error('Failed to initialize LLM service:', llmError);
        throw new Error(`LLM initialization failed: ${llmError instanceof Error ? llmError.message : 'Unknown error'}`);
      }
    }

    // Initialize curation service
    logger.info('Initializing curation service...');

    // Create storage adapter that matches the expected interface
    // S3Storage has upload(content, path, options) but interface expects upload(path, content, options)
    const storageAdapter = {
      generateSignedUrl: async (path: string, expireInSeconds: number, type?: 'get' | 'put') => {
        return getFilesStorage().getSignedUrl(path, type || 'get', { expiresIn: expireInSeconds });
      },
      upload: async (
        path: string,
        content: string | Buffer,
        options?: { ContentType?: string; ContentLength?: number }
      ) => {
        return getFilesStorage().upload(content, path, options);
      },
    };

    const curationService = new notebookCurationService.NotebookCurationService({
      sessionRepository,
      chatHistoryRepository: questRepository, // Quests are the chat history items
      fabFileRepository,
      fileStorageService: storageAdapter,
      creditTransactionRepository,
      userRepository,
      logger,
      llmService,
      llmModelId, // Pass the model ID from OperationsModelService
      // Progress callback to send WebSocket updates
      onProgress: async progress => {
        await sendToClient(userId, websocketEndpoint, {
          action: 'notebook_curation_progress',
          curationJobId,
          sessionId,
          status: progress.stage,
          stage: progress.stage,
          percentage: progress.percentage,
          message: progress.message,
          messagesProcessed: progress.messagesProcessed,
          totalMessages: progress.totalMessages,
          artifactsFound: progress.artifactsFound,
        });
      },
    });

    // Map artifact types to individual flags
    // If artifactTypes is undefined/null (not sent), include all by default
    // If artifactTypes is empty array [], include none (user explicitly deselected all)
    // If artifactTypes has items, include only those
    const includeAll = artifactTypes === undefined || artifactTypes === null;
    const artifactSet = new Set(artifactTypes || []);

    // Curation options
    const options: CurationOptions = {
      curationType: (curationType as any) || 'transcript',
      // CODE, REACT, and HTML all map to includeCode
      includeCode: includeAll || artifactSet.has('CODE') || artifactSet.has('REACT') || artifactSet.has('HTML'),
      // MERMAID and SVG map to includeDiagrams
      includeDiagrams: includeAll || artifactSet.has('MERMAID') || artifactSet.has('SVG'),
      // RECHARTS maps to includeDataViz
      includeDataViz: includeAll || artifactSet.has('RECHARTS'),
      // QUESTMASTER_PLAN maps to includeQuestMaster
      includeQuestMaster: includeAll || artifactSet.has('QUESTMASTER_PLAN'),
      // DEEP_RESEARCH maps to includeResearch
      includeResearch: includeAll || artifactSet.has('DEEP_RESEARCH'),
      // IMAGE maps to includeImages
      includeImages: includeAll || artifactSet.has('IMAGE'),
      tokenBudget: curationType === 'executive_summary' ? 100 : 100, // Base cost (LLM tokens added separately)
      exportFormat: exportFormat || 'markdown',
      customNotebookName,
    };

    // Perform curation
    logger.info('Starting curation with options:', options);
    let result;
    try {
      result = await curationService.curateNotebook(sessionId, userId, options);
      logger.info('Curation service call completed, checking result...');
    } catch (curationError) {
      logger.error('Exception thrown during curateNotebook call:', {
        error: curationError,
        message: curationError instanceof Error ? curationError.message : 'Unknown',
        stack: curationError instanceof Error ? curationError.stack : undefined,
      });
      throw new Error(
        `Curation failed due to unexpected error: ${curationError instanceof Error ? curationError.message : 'Unknown'}`
      );
    }

    if (!result.success) {
      logger.error('Curation service returned failure:', {
        success: result.success,
        error: result.error,
        errorDetails: result,
      });
      throw new Error(result.error || 'Curation failed');
    }

    logger.info('Curation service completed successfully:', {
      curatedFileId: result.curatedFileId,
      artifactCount: result.artifactCount,
      messageCount: result.messageCount,
      tokensProcessed: result.tokensProcessed,
      tokensDeducted: result.tokensDeducted,
    });

    // Send completion via WebSocket
    await sendToClient(userId, websocketEndpoint, {
      action: 'notebook_curation_progress',
      curationJobId,
      sessionId,
      status: 'completed',
      percentage: 100,
      message: 'Curation completed successfully!',
      curatedFileId: result.curatedFileId,
      tokensDeducted: result.tokensDeducted,
    });

    // Publish completion event with actual values used (not undefined)
    await NotebookCurationEvents.Complete.publish({
      curationJobId,
      sessionId,
      userId,
      curatedFileId: result.curatedFileId!,
      artifactCount: result.artifactCount!,
      messageCount: result.messageCount!,
      tokensProcessed: result.tokensProcessed!,
      curationType: curationType || 'transcript',
      exportFormat: exportFormat || 'markdown',
      artifactTypes,
    });

    // Record successful completion for idempotency on redelivery.
    await NotebookCurationJob.updateOne(
      { curationJobId },
      { $set: { status: 'completed', sessionId, userId } },
      { upsert: true }
    );

    logger.info(`Successfully completed notebook curation for session ${sessionId}`, result);
  } catch (error) {
    logger.error(`Failed to curate notebook ${sessionId}:`, error);

    // Send error update via WebSocket
    await sendToClient(userId, websocketEndpoint, {
      action: 'notebook_curation_progress',
      curationJobId,
      sessionId,
      status: 'failed',
      percentage: 0,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });

    // Publish error event
    await NotebookCurationEvents.Error.publish({
      curationJobId,
      sessionId,
      userId,
      error: error instanceof Error ? error.message : 'Unknown error',
      stage: 'loading',
    });

    // Failures are intentionally NOT recorded. Re-throwing
    // lets SQS retry the message and, if it keeps failing, route it to the DLQ -
    // preserving resilience against transient failures. Recording a terminal
    // 'failed' here would neuter that retry on redelivery.
    throw error;
  }
});
