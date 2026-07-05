import {
  NotebookExportFormat,
  ExportedNotebook,
  ExportedChatMessage,
  ExportedKnowledgeFile,
  ExportedArtifact,
  ExportedTool,
  ExportedAgent,
  NotebookImportOptions,
  ImportResult,
  NotebookImportError,
  SUPPORTED_IMPORT_VERSIONS,
} from '../notebookExportService/types';

export interface NotebookImportAdapters {
  sessionRepository: any; // SessionRepository
  chatHistoryRepository: any; // ChatHistoryRepository
  knowledgeRepository: any; // KnowledgeRepository
  artifactRepository: any; // ArtifactRepository
  toolRepository: any; // ToolRepository
  agentRepository: any; // AgentRepository
  fileStorageService: any; // FileStorageService
  userRepository: any; // UserRepository
  logger: any; // Logger
  generateId: () => string; // ID generation function
}

export class NotebookImportService {
  constructor(private adapters: NotebookImportAdapters) {}

  async importNotebooks(
    targetUserId: string,
    importData: NotebookExportFormat | string,
    options: NotebookImportOptions
  ): Promise<ImportResult> {
    try {
      this.adapters.logger.info('Starting notebook import', { targetUserId, options });

      // Parse import data if it's a string
      const parsedData = typeof importData === 'string' ? JSON.parse(importData) : importData;

      // Validate format
      this.validateImportData(parsedData);

      // Verify target user exists
      const targetUser = await this.adapters.userRepository.findById(targetUserId);
      if (!targetUser) {
        throw new NotebookImportError('Target user not found', 'USER_NOT_FOUND');
      }

      const result: ImportResult = {
        success: true,
        importedNotebooks: 0,
        importedMessages: 0,
        importedAttachments: 0,
        skippedNotebooks: 0,
        errors: [],
        warnings: [],
        newNotebookIds: [],
      };

      // Process each notebook
      for (const notebook of parsedData.notebooks) {
        try {
          const importedNotebookId = await this.importNotebook(notebook, targetUserId, options);

          if (importedNotebookId) {
            result.importedNotebooks++;
            result.importedMessages += notebook.chatHistory.length;
            result.importedAttachments += this.countAttachments(notebook);
            result.newNotebookIds!.push(importedNotebookId);
          } else {
            result.skippedNotebooks++;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.errors!.push(`Failed to import notebook "${notebook.name}": ${errorMessage}`);
          this.adapters.logger.error('Notebook import failed', {
            notebookName: notebook.name,
            error,
          });
        }
      }

      // Determine overall success
      result.success = result.errors!.length === 0 || result.importedNotebooks > 0;

      this.adapters.logger.info('Notebook import completed', result);
      return result;
    } catch (error) {
      this.adapters.logger.error('Notebook import failed', { targetUserId, error });

      if (error instanceof NotebookImportError) {
        throw error;
      }

      throw new NotebookImportError('Import failed due to unexpected error', 'IMPORT_FAILED', error);
    }
  }

  private validateImportData(data: NotebookExportFormat): void {
    if (!data.exportVersion) {
      throw new NotebookImportError('Missing export version', 'INVALID_FORMAT');
    }

    if (!SUPPORTED_IMPORT_VERSIONS.includes(data.exportVersion)) {
      throw new NotebookImportError(`Unsupported export version: ${data.exportVersion}`, 'UNSUPPORTED_VERSION');
    }

    if (!data.notebooks || !Array.isArray(data.notebooks)) {
      throw new NotebookImportError('Invalid notebooks data', 'INVALID_FORMAT');
    }

    if (data.notebooks.length === 0) {
      throw new NotebookImportError('No notebooks to import', 'NO_NOTEBOOKS');
    }
  }

  private async importNotebook(
    notebook: ExportedNotebook,
    targetUserId: string,
    options: NotebookImportOptions
  ): Promise<string | null> {
    // Check for existing notebook
    const existingSession = await this.findExistingSession(notebook, targetUserId, options);

    if (existingSession) {
      return this.handleExistingSession(existingSession, notebook, options);
    }

    // Create new session
    const newSessionId = options.preserveIds ? notebook.id : this.adapters.generateId();

    const sessionData = {
      id: newSessionId,
      userId: targetUserId,
      name: this.generateSessionName(notebook.name, options),
      firstCreated: new Date(notebook.firstCreated),
      lastUpdated: new Date(notebook.lastUpdated),
      language: notebook.language,
      summary: notebook.summary,
      summaryAt: notebook.summaryAt ? new Date(notebook.summaryAt) : undefined,
      tags: notebook.tags || [],
      isAutoNamed: notebook.isAutoNamed,
      lastUsedModel: notebook.lastUsedModel,
      knowledgeIds: [] as string[],
      artifactIds: [] as string[],
      toolIds: [] as string[],
      agentIds: [] as string[],
    };

    // Import attachments first to get IDs
    if (options.importKnowledge && notebook.knowledge.length > 0) {
      sessionData.knowledgeIds = await this.importKnowledgeFiles(notebook.knowledge, targetUserId, options);
    }

    if (options.importArtifacts && notebook.artifacts.length > 0) {
      sessionData.artifactIds = await this.importArtifacts(notebook.artifacts, targetUserId, options);
    }

    if (options.importTools && notebook.tools.length > 0) {
      sessionData.toolIds = await this.importTools(notebook.tools, targetUserId, options);
    }

    if (options.importAgents && notebook.agents.length > 0) {
      sessionData.agentIds = await this.importAgents(notebook.agents, targetUserId, options);
    }

    // Create session
    const createdSession = await this.adapters.sessionRepository.create(sessionData);

    // Import chat history
    if (notebook.chatHistory.length > 0) {
      await this.importChatHistory(notebook.chatHistory, createdSession.id, options);
    }

    return createdSession.id;
  }

  private async findExistingSession(
    notebook: ExportedNotebook,
    targetUserId: string,
    options: NotebookImportOptions
  ): Promise<any> {
    // Try to find by exact name match
    const existingSessions = await this.adapters.sessionRepository.find({
      userId: targetUserId,
      name: notebook.name,
    });

    return existingSessions.length > 0 ? existingSessions[0] : null;
  }

  private async handleExistingSession(
    existingSession: any,
    notebook: ExportedNotebook,
    options: NotebookImportOptions
  ): Promise<string | null> {
    switch (options.conflictResolution) {
      case 'skip':
        return null;

      case 'overwrite':
        // Delete existing chat history and replace
        await this.adapters.chatHistoryRepository.deleteMany({ sessionId: existingSession.id });
        await this.importChatHistory(notebook.chatHistory, existingSession.id, options);

        // Update session metadata
        await this.adapters.sessionRepository.updateById(existingSession.id, {
          lastUpdated: new Date(notebook.lastUpdated),
          summary: notebook.summary,
          summaryAt: notebook.summaryAt ? new Date(notebook.summaryAt) : undefined,
          tags: notebook.tags,
          lastUsedModel: notebook.lastUsedModel,
        });

        return existingSession.id;

      case 'rename': {
        // Create with renamed title
        const renamedNotebook = { ...notebook };
        renamedNotebook.name = await this.generateUniqueName(notebook.name, existingSession.userId);
        return await this.importNotebook(renamedNotebook, existingSession.userId, {
          ...options,
          conflictResolution: 'skip', // Prevent infinite recursion
        });
      }

      case 'merge':
        // Append chat history to existing session
        await this.importChatHistory(notebook.chatHistory, existingSession.id, options);

        // Update last updated time
        await this.adapters.sessionRepository.updateById(existingSession.id, {
          lastUpdated: new Date(),
        });

        return existingSession.id;

      default:
        throw new NotebookImportError(`Unknown conflict resolution: ${options.conflictResolution}`, 'INVALID_OPTION');
    }
  }

  private async importChatHistory(
    chatHistory: ExportedChatMessage[],
    sessionId: string,
    options: NotebookImportOptions
  ): Promise<void> {
    const chatItems = chatHistory.map(message => ({
      id: options.preserveIds ? message.id : this.adapters.generateId(),
      sessionId,
      timestamp: new Date(message.timestamp),
      type: message.type,
      prompt: message.prompt,
      reply: message.reply,
      replies: message.replies,
      questMasterReply: message.questMasterReply,
      images: message.images || [],
      fabFileIds: message.attachedFiles || [],
      promptMeta: message.promptMeta,
      status: message.status,
      creditsUsed: message.creditsUsed,
      pinned: message.pinned,
      agentIds: message.agentIds || [],
      questMasterPlanId: message.questMasterPlanId,
    }));

    // Bulk create chat history items
    await this.adapters.chatHistoryRepository.bulkCreate(chatItems);
  }

  private async importKnowledgeFiles(
    knowledgeFiles: ExportedKnowledgeFile[],
    targetUserId: string,
    options: NotebookImportOptions
  ): Promise<string[]> {
    const importedIds: string[] = [];

    for (const file of knowledgeFiles) {
      try {
        const newFileId = options.preserveIds ? file.id : this.adapters.generateId();

        let filePath: string;

        // Handle embedded content vs. reference
        if (file.content) {
          // Decode base64 content and upload
          const content = Buffer.from(file.content, 'base64');
          filePath = `knowledge/${targetUserId}/${newFileId}`;
          await this.adapters.fileStorageService.uploadFile(filePath, content);
        } else if (file.contentUrl) {
          // Copy from existing location
          filePath = await this.copyFileFromUrl(file.contentUrl, targetUserId, newFileId);
        } else {
          throw new Error('No content or URL provided for file');
        }

        // Create knowledge record
        const knowledgeData = {
          id: newFileId,
          userId: targetUserId,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          path: filePath,
          uploadedAt: new Date(file.uploadedAt),
          metadata: file.metadata,
        };

        await this.adapters.knowledgeRepository.create(knowledgeData);
        importedIds.push(newFileId);
      } catch (error) {
        this.adapters.logger.warn('Failed to import knowledge file', {
          fileName: file.name,
          error,
        });
      }
    }

    return importedIds;
  }

  private async importArtifacts(
    artifacts: ExportedArtifact[],
    targetUserId: string,
    options: NotebookImportOptions
  ): Promise<string[]> {
    const importedIds: string[] = [];

    for (const artifact of artifacts) {
      try {
        const newArtifactId = options.preserveIds ? artifact.id : this.adapters.generateId();

        const artifactData = {
          id: newArtifactId,
          userId: targetUserId,
          name: artifact.name,
          type: artifact.type,
          content: artifact.content,
          createdAt: new Date(artifact.createdAt),
          updatedAt: new Date(artifact.updatedAt),
          metadata: artifact.metadata,
        };

        await this.adapters.artifactRepository.create(artifactData);
        importedIds.push(newArtifactId);
      } catch (error) {
        this.adapters.logger.warn('Failed to import artifact', {
          artifactName: artifact.name,
          error,
        });
      }
    }

    return importedIds;
  }

  private async importTools(
    tools: ExportedTool[],
    targetUserId: string,
    options: NotebookImportOptions
  ): Promise<string[]> {
    const importedIds: string[] = [];

    for (const tool of tools) {
      try {
        const newToolId = options.preserveIds ? tool.id : this.adapters.generateId();

        const toolData = {
          id: newToolId,
          userId: targetUserId,
          name: tool.name,
          description: tool.description,
          configuration: tool.configuration,
          createdAt: new Date(tool.createdAt),
          metadata: tool.metadata,
        };

        await this.adapters.toolRepository.create(toolData);
        importedIds.push(newToolId);
      } catch (error) {
        this.adapters.logger.warn('Failed to import tool', {
          toolName: tool.name,
          error,
        });
      }
    }

    return importedIds;
  }

  private async importAgents(
    agents: ExportedAgent[],
    targetUserId: string,
    options: NotebookImportOptions
  ): Promise<string[]> {
    const importedIds: string[] = [];

    for (const agent of agents) {
      try {
        const newAgentId = options.preserveIds ? agent.id : this.adapters.generateId();

        const agentData = {
          id: newAgentId,
          userId: targetUserId,
          name: agent.name,
          description: agent.description,
          configuration: agent.configuration,
          createdAt: new Date(agent.createdAt),
          metadata: agent.metadata,
        };

        await this.adapters.agentRepository.create(agentData);
        importedIds.push(newAgentId);
      } catch (error) {
        this.adapters.logger.warn('Failed to import agent', {
          agentName: agent.name,
          error,
        });
      }
    }

    return importedIds;
  }

  private generateSessionName(originalName: string, options: NotebookImportOptions): string {
    if (options.namePrefix) {
      return `${options.namePrefix}${originalName}`;
    }
    return originalName;
  }

  private async generateUniqueName(baseName: string, userId: string): Promise<string> {
    let counter = 1;
    let candidateName = `${baseName} (${counter})`;

    while (true) {
      const existing = await this.adapters.sessionRepository.find({
        userId,
        name: candidateName,
      });

      if (existing.length === 0) {
        return candidateName;
      }

      counter++;
      candidateName = `${baseName} (${counter})`;
    }
  }

  private async copyFileFromUrl(sourceUrl: string, targetUserId: string, newFileId: string): Promise<string> {
    // Not yet implemented - returns the source URL as a fallback.
    return sourceUrl;
  }

  private countAttachments(notebook: ExportedNotebook): number {
    return notebook.knowledge.length + notebook.artifacts.length + notebook.tools.length + notebook.agents.length;
  }
}

// Re-export types for external consumption
export * from '../notebookExportService/types';
