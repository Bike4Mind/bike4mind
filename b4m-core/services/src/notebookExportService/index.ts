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
import type { ILogger } from '@bike4mind/observability';
import type {
  IAgentDocument,
  IArtifactDocument,
  IChatHistoryItem,
  IFabFileDocument,
  ISession,
  IToolDocument,
} from '@bike4mind/common';

/** Mongo filter; stays loose because callers pass operator objects (`{ _id: { $in: [...] } }`). */
type ExportQuery = Record<string, unknown>;

/** Built by mutation below, so the date sub-filter needs a declared shape. */
type SessionQuery = {
  userId: string;
  _id?: { $in: string[] };
  lastUpdated?: { $gte?: Date; $lte?: Date };
};

/** What BaseRepository.find destructures; a typo here would land in its projection instead. */
interface ExportReadOptions {
  skip?: number;
  limit?: number;
  sort?: Record<string, 1 | -1>;
}

/** The read surface this service uses. Callers wire a real repository or a minimal stand-in. */
interface ExportReads<T> {
  // Method syntax on purpose: parameters stay bivariant, which is what lets the real repositories
  // (and the hand-rolled stub in the API route) satisfy this. An arrow property would not compile.
  find(query: ExportQuery, options?: ExportReadOptions): Promise<T[]>;
}

/**
 * Rows are derived from the entity types rather than typed as `any`, so a field rename on an entity
 * breaks this file at compile time.
 */
type SessionRow = Pick<
  ISession,
  | 'id'
  | 'name'
  | 'firstCreated'
  | 'lastUpdated'
  | 'language'
  | 'summary'
  | 'summaryAt'
  | 'tags'
  | 'isAutoNamed'
  | 'lastUsedModel'
  | 'knowledgeIds'
  | 'artifactIds'
  | 'toolIds'
  | 'agentIds'
  | 'clonedSourceId'
  | 'forkedSourceId'
>;

type KnowledgeRow = Pick<
  IFabFileDocument,
  'id' | 'fileName' | 'fileSize' | 'mimeType' | 'createdAt' | 'updatedAt' | 'filePath' | 'moderationStatus' | 'fileUrl'
>;

/** No `content`: the body lives in a separate collection, reached via contentId. */
type ArtifactRow = Pick<IArtifactDocument, 'id' | 'title' | 'type' | 'createdAt' | 'updatedAt' | 'metadata'>;

type ToolRow = Pick<IToolDocument, 'id' | 'name' | 'createdAt'>;

type AgentRow = Pick<IAgentDocument, 'id' | 'name' | 'description' | 'createdAt'>;

type ChatMessageRow = Pick<
  IChatHistoryItem,
  | 'id'
  | 'timestamp'
  | 'type'
  | 'prompt'
  | 'status'
  | 'pinned'
  | 'reply'
  | 'replies'
  | 'questMasterReply'
  | 'images'
  | 'fabFileIds'
  | 'agentIds'
  | 'questMasterPlanId'
  | 'creditsUsed'
  | 'promptMeta'
>;

/** Only the three storage calls this service makes, not a whole storage client. */
interface ExportFileStorage {
  getFileContent(filePath: string): Promise<string | null>;
  uploadFile(path: string, content: Buffer): Promise<void>;
  getSignedUrl(filePath: string, expiresIn?: number): Promise<string | null>;
}

export interface NotebookExportAdapters {
  sessionRepository: ExportReads<SessionRow>;
  /** The caller wires the quest repository here; the name predates that. */
  chatHistoryRepository: ExportReads<ChatMessageRow>;
  knowledgeRepository: ExportReads<KnowledgeRow> & {
    findOne(query: ExportQuery): Promise<KnowledgeRow | null>;
  };
  artifactRepository: ExportReads<ArtifactRow>;
  toolRepository: ExportReads<ToolRow>;
  agentRepository: ExportReads<AgentRow>;
  fileStorageService: ExportFileStorage;
  logger: ILogger;
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
        platform: 'lumina5',
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
    const query: SessionQuery = { userId };

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

  private async exportSession(session: SessionRow, options: NotebookExportOptions): Promise<ExportedNotebook> {
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
      lastUsedModel: session.lastUsedModel ?? undefined,
      chatHistory,
      knowledge,
      artifacts,
      tools,
      agents,
      clonedFromId: session.clonedSourceId ?? undefined,
      forkedFromId: session.forkedSourceId ?? undefined,
    };
  }

  private async exportChatHistory(sessionId: string, options: NotebookExportOptions): Promise<ExportedChatMessage[]> {
    const MAX_MESSAGES_PER_BATCH = 100;

    const allMessages: ExportedChatMessage[] = [];
    let skip = 0;
    let hasMore = true;
    let totalTokensProcessed = 0;

    this.adapters.logger.info('Starting chat history export with batched loading', {
      sessionId,
      maxMessagesPerBatch: MAX_MESSAGES_PER_BATCH,
    });

    while (hasMore) {
      // Chronological, oldest first
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

      const processedBatch: ExportedChatMessage[] = [];

      for (const message of batch) {
        totalTokensProcessed += this.estimateTokens(message);
        // A row with no id is skipped; see processMessage.
        const exportedMessage = await this.processMessage(message, options);
        if (exportedMessage) processedBatch.push(exportedMessage);
      }

      allMessages.push(...processedBatch);
      // Advance by what the repository returned, not by what we kept: skipped rows still occupy a
      // position in the sort, so cursoring past anything less would re-read them forever.
      skip += batch.length;
      hasMore = batch.length === MAX_MESSAGES_PER_BATCH;
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
      knowledgeFiles.map(async (file: KnowledgeRow) => {
        const exportedFile: ExportedKnowledgeFile = {
          id: file.id,
          name: file.fileName,
          mimeType: file.mimeType,
          size: file.fileSize,
          uploadedAt: (file.createdAt ?? file.updatedAt ?? new Date()).toISOString(),
        };

        // A held/blocked uploaded image must not have its bytes or URL exported. Keep the file's
        // listing entry but omit content/contentUrl, matching how a file whose content fails to
        // load still appears in the export.
        if (!isImageServeable(file)) {
          this.adapters.logger.warn('Skipping content for non-serveable image', {
            fileId: file.id,
            moderationStatus: file.moderationStatus,
          });
        } else if ((exportedFile.size || 0) <= options.maxFileSize) {
          try {
            const storagePath = file.filePath;
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

    return artifacts.map((artifact: ArtifactRow) => ({
      id: artifact.id,
      // Artifacts store this as `title`; reading `name` here always produced undefined.
      name: artifact.title,
      type: artifact.type,
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

    return tools.map((tool: ToolRow) => ({
      id: tool.id,
      name: tool.name,
      createdAt: tool.createdAt?.toISOString() || new Date().toISOString(),
    }));
  }

  private async exportAgents(agentIds: string[], options: NotebookExportOptions): Promise<ExportedAgent[]> {
    if (agentIds.length === 0) return [];

    const agents = await this.adapters.agentRepository.find({
      _id: { $in: agentIds },
    });

    return agents.map((agent: AgentRow) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      createdAt: agent.createdAt?.toISOString() || new Date().toISOString(),
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
          // getFileContent reports a failed read as null. Buffer.from(null) throws, so without
          // this the miss would surface as an exception and take the same path as a real error.
          if (imageContent === null) {
            this.adapters.logger.warn('Image content unavailable, exporting the path instead', { imagePath });
            return imagePath;
          }
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
  private estimateTokens(message: ChatMessageRow): number {
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
  private async processMessage(
    message: ChatMessageRow,
    options: NotebookExportOptions
  ): Promise<ExportedChatMessage | null> {
    // IChatHistoryItem declares `id?`, and re-import keys updateOne on it: a missing id casts the
    // filter to {} and upserts over an arbitrary quest. Drop the row rather than emit that.
    if (!message.id) {
      this.adapters.logger.warn('Skipping chat message with no id');
      return null;
    }

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
      const { model, tokenUsage, performance, context } = message.promptMeta;
      exportedMessage.promptMeta = {
        model,
        tokenUsage,
        // performance and context are projected, not passed through: the full context group
        // carries systemPrompt, userPrompt and conversationContext - raw prompt text that this
        // export has never contained, and that `anonymize` does not strip.
        performance: performance && { totalResponseTime: performance.totalResponseTime },
        context: context && { contextWindowUsage: context.contextWindowUsage },
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
