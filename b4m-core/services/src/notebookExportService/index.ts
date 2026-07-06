import {
  NotebookExportFormat,
  ExportedNotebook,
  ExportedChatMessage,
  ExportedKnowledgeFile,
  ExportedArtifact,
  ExportedTool,
  ExportedAgent,
  NotebookExportOptions,
  ExportResult,
  NotebookExportError,
  CURRENT_EXPORT_VERSION,
} from './types';
import { isImageServeable } from '@bike4mind/common';

export interface NotebookExportAdapters {
  sessionRepository: any; // SessionRepository
  chatHistoryRepository: any; // ChatHistoryRepository
  knowledgeRepository: any; // KnowledgeRepository
  artifactRepository: any; // ArtifactRepository
  toolRepository: any; // ToolRepository
  agentRepository: any; // AgentRepository
  fileStorageService: any; // FileStorageService
  logger: any; // Logger
}

export class NotebookExportService {
  constructor(private adapters: NotebookExportAdapters) {}

  async exportNotebooks(userId: string, options: NotebookExportOptions): Promise<ExportResult> {
    try {
      this.adapters.logger.info('Starting notebook export', { userId, options });

      // Get sessions to export
      const sessions = await this.getSessionsToExport(userId, options);

      if (sessions.length === 0) {
        throw new NotebookExportError('No notebooks found to export', 'NO_NOTEBOOKS');
      }

      // Build export data
      const exportData: NotebookExportFormat = {
        exportVersion: CURRENT_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        exportedBy: options.anonymize ? undefined : userId,
        platform: 'bike4mind',
        notebooks: [],
      };

      let totalMessages = 0;
      let totalAttachments = 0;

      // Process each session
      for (const session of sessions) {
        const exportedNotebook = await this.exportSession(session, options);
        exportData.notebooks.push(exportedNotebook);

        totalMessages += exportedNotebook.chatHistory.length;
        totalAttachments +=
          exportedNotebook.knowledge.length +
          exportedNotebook.artifacts.length +
          exportedNotebook.tools.length +
          exportedNotebook.agents.length;
      }

      // Generate file
      const fileName = this.generateFileName(userId, options);
      const fileContent = JSON.stringify(exportData, null, 2);
      const fileSize = Buffer.byteLength(fileContent, 'utf8');

      // Store file (could be S3, local, etc.)
      const downloadUrl = await this.storeExportFile(fileName, fileContent);

      this.adapters.logger.info('Notebook export completed', {
        userId,
        notebookCount: exportData.notebooks.length,
        totalMessages,
        totalAttachments,
        fileSize,
      });

      return {
        success: true,
        fileName,
        fileSize,
        notebookCount: exportData.notebooks.length,
        messageCount: totalMessages,
        attachmentCount: totalAttachments,
        downloadUrl,
      };
    } catch (error) {
      this.adapters.logger.error('Notebook export failed', { userId, error });

      if (error instanceof NotebookExportError) {
        throw error;
      }

      throw new NotebookExportError('Export failed due to unexpected error', 'EXPORT_FAILED', error);
    }
  }

  private async getSessionsToExport(userId: string, options: NotebookExportOptions) {
    const query: any = { userId };

    // Filter by specific notebook IDs
    if (options.notebookIds && options.notebookIds.length > 0) {
      query._id = { $in: options.notebookIds };
    }

    // Date range filtering
    if (options.fromDate || options.toDate) {
      query.lastUpdated = {};
      if (options.fromDate) {
        query.lastUpdated.$gte = new Date(options.fromDate);
      }
      if (options.toDate) {
        query.lastUpdated.$lte = new Date(options.toDate);
      }
    }

    return await this.adapters.sessionRepository.find(query);
  }

  private async exportSession(session: any, options: NotebookExportOptions): Promise<ExportedNotebook> {
    // Export chat history
    const chatHistory = await this.exportChatHistory(session.id, options);

    // Export attachments based on options
    const knowledge = options.includeKnowledge ? await this.exportKnowledge(session.knowledgeIds || [], options) : [];

    const artifacts = options.includeArtifacts ? await this.exportArtifacts(session.artifactIds || [], options) : [];

    const tools = options.includeTools ? await this.exportTools(session.toolIds || [], options) : [];

    const agents = options.includeAgents ? await this.exportAgents(session.agentIds || [], options) : [];

    return {
      id: session.id,
      name: session.name,
      firstCreated: new Date(session.firstCreated ?? Date.now()).toISOString(),
      lastUpdated: new Date(session.lastUpdated ?? Date.now()).toISOString(),
      language: session.language,
      summary: session.summary,
      summaryAt: session.summaryAt ? new Date(session.summaryAt).toISOString() : undefined,
      tags: session.tags || [],
      isAutoNamed: session.isAutoNamed || false,
      lastUsedModel: session.lastUsedModel,
      chatHistory,
      knowledge,
      artifacts,
      tools,
      agents,
      clonedFromId: session.clonedSourceId,
      forkedFromId: session.forkedSourceId,
    };
  }

  private async exportChatHistory(sessionId: string, options: NotebookExportOptions): Promise<ExportedChatMessage[]> {
    // Load messages in token-aware batches (like Claude Code does)
    // Stop at 100 messages OR 50,000 tokens, whichever comes first
    const MAX_MESSAGES_PER_BATCH = 100;
    const MAX_TOKENS_PER_BATCH = 50000; // Ratchet: stop early if budget exceeded

    const allMessages: ExportedChatMessage[] = [];
    let skip = 0;
    let hasMore = true;
    let totalTokensProcessed = 0;

    this.adapters.logger.info('Starting chat history export with token-aware batched loading', {
      sessionId,
      maxMessagesPerBatch: MAX_MESSAGES_PER_BATCH,
      maxTokensPerBatch: MAX_TOKENS_PER_BATCH,
    });

    while (hasMore) {
      // Load batch chronologically (oldest first)
      // We load MAX_MESSAGES_PER_BATCH, but may stop early if tokens exceeded
      const batch = await this.adapters.chatHistoryRepository.find(
        { sessionId },
        {
          skip,
          limit: MAX_MESSAGES_PER_BATCH,
          sort: { timestamp: 1 }, // Chronological order (oldest first)
        }
      );

      if (batch.length === 0) {
        hasMore = false;
        break;
      }

      // Token-aware processing: stop batch early if token budget exceeded
      let batchTokens = 0;
      let messagesInBatch = 0;
      const processedBatch: ExportedChatMessage[] = [];

      this.adapters.logger.debug('Processing message batch (token-aware)', {
        sessionId,
        batchNumber: Math.floor(skip / MAX_MESSAGES_PER_BATCH) + 1,
        maxMessagesInBatch: batch.length,
        totalProcessed: skip,
      });

      // Process messages sequentially with token budget checking
      for (const message of batch) {
        // Estimate tokens for this message (rough: total chars / 4)
        const messageTokens = this.estimateTokens(message);

        // Ratchet check: would this message exceed our token budget?
        if (messagesInBatch > 0 && batchTokens + messageTokens > MAX_TOKENS_PER_BATCH) {
          this.adapters.logger.debug('Token budget exceeded mid-batch, stopping early', {
            sessionId,
            messagesInBatch,
            batchTokens,
            nextMessageTokens: messageTokens,
            budgetExceeded: true,
          });
          // Stop processing this batch, continue in next iteration
          break;
        }

        // Process this message
        const exportedMessage = await this.processMessage(message, options);
        processedBatch.push(exportedMessage);

        batchTokens += messageTokens;
        messagesInBatch++;
      }

      totalTokensProcessed += batchTokens;

      this.adapters.logger.debug('Batch processing complete', {
        sessionId,
        messagesInBatch,
        batchTokens,
        totalTokensProcessed,
        totalMessagesProcessed: skip + messagesInBatch,
      });

      allMessages.push(...processedBatch);
      skip += messagesInBatch; // Advance by actual messages processed (not MAX_MESSAGES_PER_BATCH)
      hasMore = messagesInBatch === MAX_MESSAGES_PER_BATCH; // Only continue if we hit message limit (not token limit)
    }

    this.adapters.logger.info('Chat history export completed', {
      sessionId,
      totalMessages: allMessages.length,
      totalTokensProcessed,
    });

    return allMessages;
  }

  private async exportKnowledge(
    knowledgeIds: string[],
    options: NotebookExportOptions
  ): Promise<ExportedKnowledgeFile[]> {
    if (knowledgeIds.length === 0) return [];

    const knowledgeFiles = await this.adapters.knowledgeRepository.find({
      _id: { $in: knowledgeIds },
    });

    return Promise.all(
      knowledgeFiles.map(async (file: any) => {
        const exportedFile: ExportedKnowledgeFile = {
          id: file.id,
          name: file.fileName ?? file.name,
          mimeType: file.mimeType,
          size: file.fileSize ?? file.size ?? 0,
          uploadedAt: (file.createdAt ?? file.updatedAt ?? new Date()).toISOString(),
          // metadata is optional; include if present
          metadata: file.metadata,
        };

        // A held/blocked uploaded image must not have its bytes or URL exported. Keep the
        // metadata entry but omit content/contentUrl, matching how a file whose content
        // fails to load still keeps its metadata.
        if (!isImageServeable(file)) {
          this.adapters.logger.warn('Skipping content for non-serveable image', {
            fileId: file.id,
            moderationStatus: file.moderationStatus,
          });
        } else if ((exportedFile.size || 0) <= options.maxFileSize) {
          try {
            const storagePath: string | undefined = file.filePath ?? file.path;
            if (storagePath) {
              const content = await this.adapters.fileStorageService.getFileContent(storagePath);
              if (content) {
                exportedFile.content = Buffer.from(content).toString('base64');
              } else {
                exportedFile.contentUrl = file.fileUrl ?? storagePath; // Fallback to URL or path reference
              }
            } else {
              exportedFile.contentUrl = file.fileUrl; // No storage path; use available URL
            }
          } catch (error) {
            this.adapters.logger.warn('Failed to export file content', { fileId: file.id, error });
            exportedFile.contentUrl = file.fileUrl ?? file.filePath; // Fallback to reference
          }
        } else {
          exportedFile.contentUrl = file.fileUrl ?? file.filePath;
        }

        return exportedFile;
      })
    );
  }

  private async exportArtifacts(artifactIds: string[], options: NotebookExportOptions): Promise<ExportedArtifact[]> {
    if (artifactIds.length === 0) return [];

    const artifacts = await this.adapters.artifactRepository.find({
      _id: { $in: artifactIds },
    });

    return artifacts.map((artifact: any) => ({
      id: artifact.id,
      name: artifact.name,
      type: artifact.type,
      content: artifact.content,
      createdAt: artifact.createdAt?.toISOString() || new Date().toISOString(),
      updatedAt: artifact.updatedAt?.toISOString() || new Date().toISOString(),
      metadata: artifact.metadata,
    }));
  }

  private async exportTools(toolIds: string[], options: NotebookExportOptions): Promise<ExportedTool[]> {
    if (toolIds.length === 0) return [];

    const tools = await this.adapters.toolRepository.find({
      _id: { $in: toolIds },
    });

    return tools.map((tool: any) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      configuration: tool.configuration,
      createdAt: tool.createdAt?.toISOString() || new Date().toISOString(),
      metadata: tool.metadata,
    }));
  }

  private async exportAgents(agentIds: string[], options: NotebookExportOptions): Promise<ExportedAgent[]> {
    if (agentIds.length === 0) return [];

    const agents = await this.adapters.agentRepository.find({
      _id: { $in: agentIds },
    });

    return agents.map((agent: any) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      configuration: agent.configuration,
      createdAt: agent.createdAt?.toISOString() || new Date().toISOString(),
      metadata: agent.metadata,
    }));
  }

  private async processImages(imagePaths: string[], options: NotebookExportOptions): Promise<string[]> {
    if (!options.includeImages) return [];

    const results = await Promise.all(
      imagePaths.map(async imagePath => {
        // This path only has a bare storage key (no FabFile doc in hand). Look one up by
        // filePath via the injected knowledgeRepository (the FabFile repository - see
        // exportKnowledge above); if it matches an uploaded image that isn't serveable yet
        // (held/blocked), skip it. Generated images have no FabFile row and fall through unaffected.
        try {
          const fabFile = await this.adapters.knowledgeRepository.findOne({ filePath: imagePath });
          if (fabFile && !isImageServeable(fabFile)) {
            this.adapters.logger.warn('Skipping non-serveable image', {
              imagePath,
              moderationStatus: fabFile.moderationStatus,
            });
            return null;
          }
        } catch (error) {
          // Fail-closed: a failed moderation lookup must not export the image - skip it
          // rather than falling through, since we can't confirm it's serveable.
          this.adapters.logger.warn('Failed to look up FabFile for image moderation check, skipping image', {
            imagePath,
            error,
          });
          return null;
        }

        try {
          const imageContent = await this.adapters.fileStorageService.getFileContent(imagePath);
          return Buffer.from(imageContent).toString('base64');
        } catch (error) {
          this.adapters.logger.warn('Failed to export image', { imagePath, error });
          return imagePath; // Fallback to path reference
        }
      })
    );

    return results.filter((result): result is string => result !== null);
  }

  /**
   * Estimate token count for a message (rough approximation)
   * Uses the standard LLM heuristic: total chars / 4
   */
  private estimateTokens(message: any): number {
    let totalChars = 0;

    // Count prompt
    if (message.prompt) {
      totalChars += message.prompt.length;
    }

    // Count reply(ies)
    if (message.reply) {
      totalChars += message.reply.length;
    }
    if (message.replies && Array.isArray(message.replies)) {
      totalChars += message.replies.reduce((sum: number, r: string) => sum + r.length, 0);
    }

    // Count QuestMaster reply
    if (message.questMasterReply) {
      totalChars += message.questMasterReply.length;
    }

    // Rough token estimate (standard heuristic: 1 token ~= 4 chars)
    return Math.ceil(totalChars / 4);
  }

  /**
   * Process a single message into exported format
   */
  private async processMessage(message: any, options: NotebookExportOptions): Promise<ExportedChatMessage> {
    const exportedMessage: ExportedChatMessage = {
      id: message.id,
      timestamp: new Date(message.timestamp ?? Date.now()).toISOString(),
      type: message.type || 'message',
      prompt: message.prompt || '',
      status: message.status || 'done',
      pinned: message.pinned || false,
    };

    // Add responses
    if (message.reply) {
      exportedMessage.reply = message.reply;
    }
    if (message.replies && message.replies.length > 0) {
      exportedMessage.replies = message.replies;
    }
    if (message.questMasterReply) {
      exportedMessage.questMasterReply = message.questMasterReply;
    }

    // Add attachments
    if (message.images && message.images.length > 0 && options.includeImages) {
      exportedMessage.images = await this.processImages(message.images, options);
    }
    if (message.fabFileIds && message.fabFileIds.length > 0) {
      exportedMessage.attachedFiles = message.fabFileIds;
    }

    // Add metadata
    if (message.promptMeta && options.includeMetadata) {
      exportedMessage.promptMeta = {
        model: message.promptMeta.model,
        temperature: message.promptMeta.temperature,
        maxTokens: message.promptMeta.maxTokens,
        tokensUsed: message.promptMeta.tokensUsed,
        inputTokens: message.promptMeta.inputTokens,
        outputTokens: message.promptMeta.outputTokens,
        cost: message.promptMeta.cost,
        responseTime: message.promptMeta.responseTime,
        contextLength: message.promptMeta.contextLength,
      };
    }

    // Add agent info
    if (message.agentIds && message.agentIds.length > 0) {
      exportedMessage.agentIds = message.agentIds;
    }
    if (message.questMasterPlanId) {
      exportedMessage.questMasterPlanId = message.questMasterPlanId;
    }

    // Add credits
    if (message.creditsUsed) {
      exportedMessage.creditsUsed = message.creditsUsed;
    }

    return exportedMessage;
  }

  private generateFileName(userId: string, options: NotebookExportOptions): string {
    const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const userPrefix = options.anonymize ? 'user' : userId.substring(0, 8);

    if (options.notebookIds && options.notebookIds.length === 1) {
      return `notebook-${userPrefix}-${timestamp}.json`;
    }

    return `notebooks-${userPrefix}-${timestamp}.json`;
  }

  private async storeExportFile(fileName: string, content: string): Promise<string> {
    const path = `exports/${fileName}`;
    await this.adapters.fileStorageService.uploadFile(path, Buffer.from(content));
    const signed = await this.adapters.fileStorageService.getSignedUrl(path, 3600); // 1 hour expiry
    return signed ?? path;
  }
}

// Re-export types for external consumption
export * from './types';
