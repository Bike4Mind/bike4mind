import { Logger } from '@bike4mind/observability';
import {
  CurationOptions,
  CurationProgress,
  CurationResult,
  CurationType,
  ExtractedArtifact,
  NotebookCurationError,
} from '@bike4mind/common';
import type { CurationTokenUsage, LLMContext } from './llmMarkdownGenerator';
import { createFabFile } from '../fabFileService/create';
import { FormatConverter } from './formatConverter';
import { createHash } from 'crypto';

export interface NotebookCurationAdapters {
  sessionRepository: any; // ISessionRepository
  chatHistoryRepository: any; // IChatHistoryRepository
  fabFileRepository: any; // IFabFileRepository
  fileStorageService: any; // FileStorageService (S3Storage)
  creditTransactionRepository: any; // ICreditTransactionRepository
  userRepository: any; // IUserRepository (for creditHolderMethods)
  logger: any; // Logger
  llmService?: LLMContext; // Optional: Required for executive summary generation (Option 2)
  llmModelId?: string; // Optional: Model ID to use for LLM operations (e.g., 'gpt-4o-mini', 'claude-3-5-sonnet-bedrock')
  onProgress?: (progress: CurationProgress) => Promise<void>;
}

/**
 * Bump when the curation prompts or output format change materially, so that
 * previously cached sessions re-curate instead of serving pre-change output.
 */
const CURATION_HASH_VERSION = 'v1';

/**
 * Stable hash of everything that determines the curated output: the hash version,
 * the curation type, the include/format options, and the conversation content. An
 * unchanged re-curation produces the same hash, letting curateNotebook reuse the
 * stored file and skip the LLM + credit charge (issue #91).
 *
 * Intentionally NOT hashed:
 * - options.tokenBudget: affects only the base credit deduction, not the document.
 * - session.name: curation is a point-in-time snapshot, so a rename alone should
 *   not force a full (paid) re-curation just to refresh the header title.
 */
export function computeCurationContentHash(messages: any[], options: CurationOptions): string {
  const hash = createHash('sha256');
  hash.update(`ver:${CURATION_HASH_VERSION}`);
  hash.update(`|type:${options.curationType || 'transcript'}`);
  hash.update(`|fmt:${options.exportFormat || 'markdown'}`);
  hash.update(`|name:${options.customNotebookName || ''}`);
  hash.update(
    `|inc:${options.includeCode}${options.includeDiagrams}${options.includeDataViz}` +
      `${options.includeQuestMaster}${options.includeResearch}${options.includeImages}`
  );
  // Field-separated so content shifting between fields can't collide (e.g.
  // prompt "foo"+reply "bar" must not hash the same as prompt "fooba"+reply "r").
  for (const message of messages) {
    hash.update('|m:');
    hash.update(message.id || message._id?.toString() || '');
    hash.update('|p:');
    hash.update(message.prompt || '');
    hash.update('|r:');
    hash.update(message.reply || '');
    hash.update('|rs:');
    // JSON.stringify (not join) so ['a','b'] and ['a b'] cannot collide.
    if (Array.isArray(message.replies)) hash.update(JSON.stringify(message.replies));
    hash.update('|q:');
    hash.update(message.questMasterReply || '');
  }
  return hash.digest('hex');
}

/**
 * Notebook Curation Service
 *
 * Transforms AI conversation notebooks into curated, shareable markdown documents
 * with extracted artifacts (code, diagrams, plans, research).
 *
 * Process:
 * 1. Load conversation history with token-aware batching
 * 2. Extract artifacts (code, diagrams, QuestMaster plans, Deep Research)
 * 3. Generate structured markdown document
 * 4. Store as shareable file
 * 5. Update session metadata
 */
export class NotebookCurationService {
  constructor(private adapters: NotebookCurationAdapters) {}

  /**
   * Curate a notebook session
   *
   * @param sessionId - The session to curate
   * @param userId - The user performing the curation
   * @param options - Curation options (what to include, token budget, etc.)
   * @returns Curation result with file ID, stats, and any errors
   */
  async curateNotebook(sessionId: string, userId: string, options: CurationOptions): Promise<CurationResult> {
    try {
      this.adapters.logger.info('Starting notebook curation', { sessionId, userId, options });

      // Stage 1: Validate session exists
      await this.sendProgress({
        stage: 'loading',
        percentage: 5,
        message: 'Validating session...',
      });

      const session = await this.adapters.sessionRepository.findById(sessionId);
      if (!session) {
        throw new NotebookCurationError('Session not found', 'SESSION_NOT_FOUND');
      }

      // Stage 2: Load conversation history with token-aware batching
      await this.sendProgress({
        stage: 'loading',
        percentage: 10,
        message: 'Loading conversation history...',
      });

      const { messages, totalTokens } = await this.loadConversationHistory(sessionId);

      this.adapters.logger.info('Loaded conversation history', {
        sessionId,
        messageCount: messages.length,
        totalTokens,
      });

      await this.sendProgress({
        stage: 'loading',
        percentage: 30,
        message: `Loaded ${messages.length} messages`,
        totalMessages: messages.length,
        messagesProcessed: messages.length,
      });

      // Stage 3: Extract artifacts from messages
      await this.sendProgress({
        stage: 'extracting',
        percentage: 35,
        message: 'Extracting code and artifacts...',
      });

      const artifacts = await this.extractArtifacts(messages, options);

      this.adapters.logger.info('Extracted artifacts', {
        sessionId,
        artifactCount: artifacts.length,
        artifactTypes: this.summarizeArtifactTypes(artifacts),
      });

      await this.sendProgress({
        stage: 'extracting',
        percentage: 60,
        message: `Found ${artifacts.length} artifacts`,
        artifactsFound: artifacts.length,
      });

      // Cache check runs AFTER artifact extraction (above) on purpose: extraction
      // is cheap (no LLM) and keeps artifactCount accurate in the cache-hit return.
      // If this session was already curated with the same inputs (content + type +
      // options), reuse the stored file and skip the LLM, storage, and credit
      // charge entirely. The hash is stored on the session after a successful
      // curation below.
      const contentHash = computeCurationContentHash(messages, options);
      if (session.curatedNotebookFileId && session.curationContentHash === contentHash) {
        // Only reuse if the stored file still exists. The curated FabFile may have
        // been deleted since the last run; if so, fall through and regenerate
        // rather than return a dangling id (download would 404).
        const existingFile = await this.adapters.fabFileRepository.findById(session.curatedNotebookFileId);
        if (existingFile) {
          this.adapters.logger.info('Curation cache hit - reusing existing file, skipping LLM and credit charge', {
            sessionId,
            curatedFileId: session.curatedNotebookFileId,
            contentHash,
          });

          await this.sendProgress({
            stage: 'storing',
            percentage: 100,
            message: 'Reused existing curation (no changes since last run)',
          });

          return {
            success: true,
            curatedFileId: session.curatedNotebookFileId,
            // Mirror the regenerate path's result shape so consumers see the same
            // fields on a cache hit as on a fresh curation.
            fileName: existingFile.fileName,
            fileSize: existingFile.fileSize,
            artifactCount: artifacts.length,
            messageCount: messages.length,
            tokensProcessed: totalTokens,
            tokensDeducted: 0,
          };
        }

        this.adapters.logger.info('Curation content unchanged but stored file is missing - regenerating', {
          sessionId,
          curatedFileId: session.curatedNotebookFileId,
        });
      }

      // Stage 4: Generate markdown document
      await this.sendProgress({
        stage: 'generating',
        percentage: 65,
        message: 'Generating curated document...',
      });

      const {
        markdown,
        tokensUsed: llmTokensUsed,
        tokenUsage: llmTokenUsage,
      } = await this.generateMarkdown(session, messages, artifacts, options);

      this.adapters.logger.info('Generated markdown', {
        sessionId,
        markdownSize: markdown.length,
        llmTokensUsed,
        llmInputTokens: llmTokenUsage.inputTokens,
        llmOutputTokens: llmTokenUsage.outputTokens,
      });

      await this.sendProgress({
        stage: 'generating',
        percentage: 80,
        message: 'Document generated successfully',
      });

      // Stage 5: Store file
      await this.sendProgress({
        stage: 'storing',
        percentage: 85,
        message: 'Saving curated notebook...',
      });

      let fileId = null;
      let fileName = null;
      let fileSize = null;

      try {
        const result = await this.storeFile(
          sessionId,
          userId,
          markdown,
          options.exportFormat,
          options.customNotebookName
        );
        fileId = result.fileId;
        fileName = result.fileName;
        fileSize = result.fileSize;
      } catch (error) {
        this.adapters.logger.error('Failed to store curated file', { sessionId, userId, error });
        Logger.globalInstance.error('Failed to store curated file', error);
        throw new NotebookCurationError('Failed to store curated file', 'STORAGE_FAILED');
      }

      // Stage 6: Update session metadata (store the content hash so an unchanged
      // re-curation hits the cache above and skips the LLM next time)
      await this.adapters.sessionRepository.update({
        id: sessionId,
        curatedNotebookFileId: fileId,
        curatedAt: new Date(),
        curationContentHash: contentHash,
      });

      this.adapters.logger.info('Updated session metadata', { sessionId, curatedFileId: fileId });

      await this.sendProgress({
        stage: 'storing',
        percentage: 100,
        message: 'Curation completed successfully!',
      });

      // Deduct tokens/credits for curation
      const { subtractCredits } = await import('../creditService/subtractCredits');
      const { CreditHolderType } = await import('@bike4mind/common');

      // Calculate total tokens: base cost (100 for processing) + LLM tokens (if executive summary)
      const baseCost = options.tokenBudget ?? 100;
      const tokensDeducted = baseCost + llmTokensUsed;

      await subtractCredits(
        {
          ownerId: userId,
          ownerType: CreditHolderType.User,
          credits: tokensDeducted,
          type: 'generic_deduct',
          reason: 'notebook_curation',
          description: `Curated notebook for session ${sessionId}`,
          metadata: {
            sessionId,
            artifactCount: artifacts.length,
            messageCount: messages.length,
            tokensProcessed: totalTokens,
            curatedFileId: fileId,
          },
        },
        {
          db: {
            creditTransactions: this.adapters.creditTransactionRepository,
          },
          creditHolderMethods: this.adapters.userRepository,
        }
      );

      this.adapters.logger.info('Deducted tokens for curation', {
        sessionId,
        userId,
        tokensDeducted,
      });

      return {
        success: true,
        curatedFileId: fileId,
        fileName,
        fileSize,
        artifactCount: artifacts.length,
        messageCount: messages.length,
        tokensProcessed: totalTokens,
        tokensDeducted,
      };
    } catch (error) {
      this.adapters.logger.error('Notebook curation failed', { sessionId, userId, error });

      if (error instanceof NotebookCurationError) {
        return {
          success: false,
          error: error.message,
        };
      }

      return {
        success: false,
        error: 'Curation failed due to unexpected error',
      };
    }
  }

  /**
   * Load conversation history with token-aware batching
   * (Reuses the pattern from notebookExportService)
   */
  private async loadConversationHistory(sessionId: string): Promise<{ messages: any[]; totalTokens: number }> {
    const MAX_MESSAGES_PER_BATCH = 100;
    const MAX_TOKENS_PER_BATCH = 50000;

    const allMessages: any[] = [];
    let skip = 0;
    let hasMore = true;
    let totalTokens = 0;

    while (hasMore) {
      const batch = await this.adapters.chatHistoryRepository.find(
        { sessionId },
        {
          skip,
          limit: MAX_MESSAGES_PER_BATCH,
          sort: { timestamp: 1 }, // Chronological order
        }
      );

      if (batch.length === 0) {
        hasMore = false;
        break;
      }

      // Token-aware processing
      let batchTokens = 0;
      let messagesInBatch = 0;

      for (const message of batch) {
        const messageTokens = this.estimateTokens(message);

        // Ratchet check
        if (messagesInBatch > 0 && batchTokens + messageTokens > MAX_TOKENS_PER_BATCH) {
          this.adapters.logger.debug('Token budget exceeded mid-batch, stopping early', {
            sessionId,
            messagesInBatch,
            batchTokens,
          });
          break;
        }

        allMessages.push(message);
        batchTokens += messageTokens;
        messagesInBatch++;
      }

      totalTokens += batchTokens;
      skip += messagesInBatch;
      hasMore = messagesInBatch === MAX_MESSAGES_PER_BATCH;
    }

    return { messages: allMessages, totalTokens };
  }

  /**
   * Estimate token count for a message
   */
  private estimateTokens(message: any): number {
    let totalChars = 0;

    if (message.prompt) totalChars += message.prompt.length;
    if (message.reply) totalChars += message.reply.length;
    if (message.replies && Array.isArray(message.replies)) {
      totalChars += message.replies.reduce((sum: number, r: string) => sum + r.length, 0);
    }
    if (message.questMasterReply) totalChars += message.questMasterReply.length;

    return Math.ceil(totalChars / 4);
  }

  /**
   * Extract artifacts from messages
   */
  private async extractArtifacts(messages: any[], options: CurationOptions): Promise<ExtractedArtifact[]> {
    const allArtifacts: ExtractedArtifact[] = [];

    for (const message of messages) {
      const { extractArtifactsFromMessage } = await import('./artifactExtractor');
      const messageArtifacts = extractArtifactsFromMessage(message, options);
      allArtifacts.push(...messageArtifacts);
    }

    this.adapters.logger.info('Extracted artifacts', {
      totalArtifacts: allArtifacts.length,
      byType: this.summarizeArtifactTypes(allArtifacts),
    });

    return allArtifacts;
  }

  /**
   * Generate markdown document
   * Routes to Option 1 (template transcript) or Option 2 (LLM executive summary)
   */
  private async generateMarkdown(
    session: any,
    messages: any[],
    artifacts: ExtractedArtifact[],
    options: CurationOptions
  ): Promise<{ markdown: string; tokensUsed: number; tokenUsage: CurationTokenUsage }> {
    // Route by curation type
    if (options.curationType === CurationType.EXECUTIVE_SUMMARY) {
      // Option 2: AI-powered executive summary
      if (!this.adapters.llmService) {
        throw new NotebookCurationError('LLM service is required for executive summary generation', 'EXPORT_FAILED');
      }

      const { generateExecutiveSummaryMarkdown } = await import('./llmMarkdownGenerator');
      const { ChatModels } = await import('@bike4mind/common');

      // Use the provided model ID, or fall back to GPT4_1 if not specified
      const modelId = this.adapters.llmModelId || ChatModels.GPT4_1;

      this.adapters.logger.info('Using model for executive summary generation', {
        modelId,
        isProvidedModel: !!this.adapters.llmModelId,
      });

      const result = await generateExecutiveSummaryMarkdown(
        session,
        messages,
        artifacts,
        this.adapters.llmService,
        modelId,
        {
          includeTimestamps: false, // Executive summaries don't need timestamps
          includeMetadata: true,
          includeTableOfContents: true,
        }
      );

      this.adapters.logger.info('Generated executive summary markdown', {
        sessionId: session.id,
        markdownLength: result.markdown.length,
        tokensUsed: result.tokensUsed,
        modelId,
        sections: ['header', 'toc', 'executive-summary', 'insights', 'decisions', 'artifacts', 'metadata'],
      });

      return result;
    } else {
      // Option 1: Template-based transcript (default)
      const { generateTranscriptMarkdown } = await import('./markdownGenerator');

      const markdown = generateTranscriptMarkdown(session, messages, artifacts, {
        includeTimestamps: true,
        includeMetadata: true,
        includeTableOfContents: true,
        groupArtifactsByType: true,
      });

      this.adapters.logger.info('Generated transcript markdown', {
        sessionId: session.id,
        markdownLength: markdown.length,
        sections: ['header', 'toc', 'summary', 'conversation', 'artifacts', 'metadata'],
      });

      return {
        markdown,
        tokensUsed: 0, // Template-based doesn't use LLM tokens
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
  }

  /**
   * Store curated file as a FabFile in the selected format
   * Saves only the format specified in options
   */
  private async storeFile(
    sessionId: string,
    userId: string,
    markdown: string,
    format: 'markdown' | 'txt' | 'html' = 'markdown',
    customNotebookName?: string
  ): Promise<{ fileId: string; fileName: string; fileSize: number }> {
    const { KnowledgeType } = await import('@bike4mind/common');

    const baseFileName = customNotebookName || `curated-notebook-${sessionId}`;

    this.adapters.logger.info('Creating FabFile for curated notebook', {
      sessionId,
      userId,
      format,
    });

    // Convert to selected format only
    const converter = new FormatConverter(this.adapters.logger);
    const converted = await converter.convert(markdown, format);

    try {
      const fabFile = await createFabFile(
        userId,
        {
          fileName: `${baseFileName}${converted.extension}`,
          mimeType: converted.mimeType,
          fileSize: Buffer.isBuffer(converted.content) ? converted.content.length : converted.content.length,
          type: KnowledgeType.FILE,
          content: Buffer.isBuffer(converted.content) ? converted.content : Buffer.from(converted.content),
          contentType: `${converted.mimeType}; charset=utf-8`,
          prefix: 'curated-notebooks',
          sessionId,
          tags: [{ name: 'curated-notebook', strength: 1.0 }],
        },
        {
          db: {
            fabFiles: this.adapters.fabFileRepository,
            adminSettings: { findAll: async () => [], findBySettingNames: async () => [] },
            users: { findById: async (id: string) => ({ id }) as any },
          },
          storage: this.adapters.fileStorageService,
        }
      );

      this.adapters.logger.info(`Created ${format} FabFile for curated notebook`, {
        sessionId,
        userId,
        fabFileId: fabFile.id,
        fileName: fabFile.fileName,
        fileSize: fabFile.fileSize,
      });

      return {
        fileId: fabFile.id,
        fileName: fabFile.fileName,
        fileSize: fabFile.fileSize,
      };
    } catch (error) {
      this.adapters.logger.error(`Failed to create ${format} file`, {
        sessionId,
        userId,
        format,
        error,
      });
      throw new Error(
        `Failed to create curated notebook file: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Send progress update to callback
   */
  private async sendProgress(progress: CurationProgress): Promise<void> {
    if (this.adapters.onProgress) {
      await this.adapters.onProgress(progress);
    }
  }

  /**
   * Summarize artifact types for logging
   */
  private summarizeArtifactTypes(artifacts: ExtractedArtifact[]): Record<string, number> {
    return artifacts.reduce(
      (acc, artifact) => {
        acc[artifact.type] = (acc[artifact.type] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
  }
}

// Re-export FormatConverter for external use
export { FormatConverter } from './formatConverter';
