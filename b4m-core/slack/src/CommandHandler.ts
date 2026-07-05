/**
 * Parses, validates, and processes agent commands from Slack messages.
 */

import { SQSService } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { PERSONA_ALLOWED_SUBAGENTS } from '@bike4mind/agents';
import { SYSTEM_MODEL_DEFAULTS } from './constants/system-model-defaults';
export { SYSTEM_MODEL_DEFAULTS };
import { parseCommand, selectAgent, type ParsedAgentCommand, type AgentPersona } from './agent-parser';
import { customAgentToPersona } from './custom-agent-adapter';
import { SlackEvent, type SlackEventData } from './SlackEvent';
import { Types } from 'mongoose';
import { updateUserSlackSettings } from './handlers/notebook-manager';
import { getSlackDeps, getSlackDb } from './di/registry';
import { notebookNew } from './tools/notebookNew';
import { notebookStatus } from './tools/notebookStatus';
import { IUserDocument } from '@bike4mind/common';
import type { SlackMessage } from './thread-intelligence/types';

const HISTORY_COUNT = 20;

import { SlackClient } from './SlackClient';
import { ChatCompletionInvoke } from '@bike4mind/services';
import { createLoadingBar } from './utils/loadingBar';

/**
 * CommandHandler class for processing Slack commands
 *
 * Usage:
 * ```typescript
 * const handler = new CommandHandler(slackEvent, user, slackClient, logger);
 * const agent = handler.agent();
 * ```
 */
export class CommandHandler {
  public parsedCommand: ParsedAgentCommand;
  private slackEvent: SlackEvent;
  private logger: Logger;
  private user: IUserDocument;
  private cachedAgent: AgentPersona | null = null;
  private customAgent: AgentPersona | null = null;
  private usingCustomAgent: boolean = false;
  private contextMessages: SlackMessage[] = [];
  private slackClient: SlackClient;
  /**
   * Create a CommandHandler instance
   * @param slackEvent - SlackEvent instance containing the message
   * @param logger - Logger instance for debugging
   */
  constructor(slackEvent: SlackEvent, user: IUserDocument, slackClient: SlackClient, logger: Logger) {
    this.slackEvent = slackEvent;
    this.user = user;
    this.slackClient = slackClient;
    this.logger = logger;
    this.parsedCommand = parseCommand(slackEvent.text);

    this.logger.debug('[Slack Routing] Command parsed', {
      agentName: this.parsedCommand.agentName,
      command: this.parsedCommand.command.substring(0, 100),
      channel: this.slackEvent.channel,
      isThreaded: this.slackEvent.isThreaded,
    });
  }

  /**
   * Load custom agent if configured in user's Slack settings
   * Should be called early in the request lifecycle
   */
  async loadCustomAgentIfConfigured(): Promise<void> {
    const customAgentId = this.user.slackSettings?.customAgentId;
    if (!customAgentId) return;

    if (!Types.ObjectId.isValid(customAgentId)) {
      this.logger.warn('Invalid custom agent ID format, using default', { customAgentId });
      return;
    }

    try {
      const { Agent } = getSlackDb();
      const agent = await (Agent as any).findOne({
        _id: customAgentId,
        $or: [{ userId: this.user.id }, { 'users.userId': this.user.id }],
        deletedAt: { $exists: false },
      });

      if (agent) {
        this.customAgent = customAgentToPersona(agent);
        this.logger.info('Loaded custom agent for @agent command', {
          agentId: customAgentId,
          agentName: agent.name,
        });
      } else {
        // Agent was deleted - log warning but continue with default
        this.logger.warn('Configured custom agent not found, using default', {
          customAgentId,
          userId: this.user.id,
        });
      }
    } catch (error) {
      this.logger.error('Failed to load custom agent', { error, customAgentId });
    }
  }

  /**
   * Resolve model config using the priority chain:
   * channel config -> agent config -> org default -> system fallback
   */
  async resolveModelConfig(): Promise<{ modelId: string; temperature: number; maxTokens: number }> {
    let channelConfig = null;
    let orgDoc = null;
    try {
      const { SlackChannelConfig, Organization } = getSlackDb();
      [channelConfig, orgDoc] = await Promise.all([
        (SlackChannelConfig as any).findOne({ channelId: this.slackEvent.channel }).lean(),
        this.user.organizationId
          ? (Organization as any)
              .findById(this.user.organizationId)
              .select('preferredModel temperature maxTokens')
              .lean()
          : null,
      ]);
    } catch (error) {
      this.logger.error('[Slack] Failed to fetch model config from database, using system defaults', {
        error,
        channelId: this.slackEvent.channel,
        organizationId: this.user.organizationId,
      });
    }
    const agentConfig = this.agent();

    // Use || for strings (treat empty string as unset), ?? for numbers (preserve 0 as valid value)
    const modelId =
      channelConfig?.preferredModel ||
      agentConfig.preferredModel ||
      orgDoc?.preferredModel ||
      SYSTEM_MODEL_DEFAULTS.modelId;
    const temperature =
      channelConfig?.temperature ?? agentConfig.temperature ?? orgDoc?.temperature ?? SYSTEM_MODEL_DEFAULTS.temperature;
    const maxTokens =
      channelConfig?.maxTokens ?? agentConfig.maxTokens ?? orgDoc?.maxTokens ?? SYSTEM_MODEL_DEFAULTS.maxTokens;

    const modelSource = channelConfig?.preferredModel
      ? 'channel'
      : agentConfig.preferredModel
        ? 'agent'
        : orgDoc?.preferredModel
          ? 'org'
          : 'system';
    const tempSource =
      channelConfig?.temperature != null
        ? 'channel'
        : agentConfig.temperature != null
          ? 'agent'
          : orgDoc?.temperature != null
            ? 'org'
            : 'system';
    const maxTokensSource =
      channelConfig?.maxTokens != null
        ? 'channel'
        : agentConfig.maxTokens != null
          ? 'agent'
          : orgDoc?.maxTokens != null
            ? 'org'
            : 'system';

    this.logger.info('[Slack] Model config resolved', {
      channelId: this.slackEvent.channel,
      modelId,
      modelSource,
      temperature,
      tempSource,
      maxTokens,
      maxTokensSource,
    });

    return { modelId, temperature, maxTokens };
  }

  /**
   * Check if using a custom agent for this command
   */
  isUsingCustomAgent(): boolean {
    return this.usingCustomAgent;
  }

  /**
   * Get the selected agent persona based on the command
   * Uses smart selection based on entities (e.g., @pm for Jira, @dev for GitHub)
   * If custom agent is configured and command is @agent, uses custom agent instead
   *
   * @returns The appropriate AgentPersona for this command
   */
  agent(): AgentPersona {
    // Use custom agent only when explicitly using @agent command
    if (this.customAgent && this.parsedCommand.agentName === 'agent') {
      this.usingCustomAgent = true;
      this.logger.debug('Using custom agent', {
        agentName: this.customAgent.name,
        parsedAgentName: this.parsedCommand.agentName,
      });
      return this.customAgent;
    }

    // Cache the agent selection to avoid recomputation
    if (!this.cachedAgent) {
      this.cachedAgent = selectAgent(this.parsedCommand!);
      this.logger.debug('Agent selected', {
        agentName: this.cachedAgent.name,
        parsedAgentName: this.parsedCommand.agentName,
      });
    }

    return this.cachedAgent;
  }

  isValidSlashCommand(): boolean {
    const rawText = this.parsedCommand.rawText.trim();
    return rawText.startsWith('/notebook') || rawText.startsWith('/help');
  }

  async handleSlashCommand(): Promise<string> {
    const slackUserId = this.slackEvent.user;
    const text = this.parsedCommand.command.trim();
    const command = text.trim().toLowerCase();

    if (command.startsWith('/notebook set ')) {
      // Set default notebook: "/notebook set [notebook-id]"
      const notebookId = command.replace('/notebook set ', '').trim();

      const slackSettings = this.user.slackSettings || {};
      await updateUserSlackSettings(this.user.id, {
        ...slackSettings,
        slackUserId,
        defaultNotebookId: notebookId,
      });

      return `✅ Default notebook set to: ${notebookId}`;
    }

    if (command === '/notebook new') {
      const result = await notebookNew({ user: this.user, slackUserId, logger: this.logger });
      return result.message;
    }

    if (command === '/notebook status') {
      const result = notebookStatus({ user: this.user });
      return result.message;
    }

    return `❓ Unknown command. Available commands:\n- \`/notebook set [id]\` - Set default notebook\n- \`/notebook new\` - Create new notebook\n- \`/notebook status\` - Show current settings`;
  }

  async getSlackContextMessages(): Promise<{ contextMessages: SlackMessage[]; threadContext: string }> {
    // Fetch context - use thread if available, otherwise channel history
    let contextMessages: SlackMessage[] = [];
    if (this.slackEvent.threadTs) {
      // This is a reply in a thread - fetch thread messages
      contextMessages = await this.slackClient.fetchThreadHistory(this.slackEvent.channel, this.slackEvent.threadTs);
    } else {
      // Regular channel message - fetch recent channel history
      contextMessages = await this.slackClient.fetchChannelHistory(this.slackEvent.channel, 20);
    }
    // Build thread context with user names
    const userNameCache = new Map<string, string>();
    const messagesWithNames = await Promise.all(
      contextMessages
        .filter(msg => msg.user && msg.text) // Filter out system messages
        .map(async msg => {
          if (!userNameCache.has(msg.user)) {
            const userName = await this.slackClient.getUserName(msg.user);
            userNameCache.set(msg.user, userName);
          }
          return `${userNameCache.get(msg.user)}: ${msg.text}`;
        })
    );
    const threadContext = messagesWithNames.join('\n');
    return { contextMessages, threadContext };
  }

  /**
   * Trigger AI response with context from channel messages
   * @param sessionId - Notebook/session ID
   * @param message - User message/prompt
   * @param systemPrompt - Unified system prompt (includes navigate_view guard, pending action context, Slack conversation context)
   * @param statusCallback - Optional callback for status updates
   * @param fabFileIds - File IDs to attach (default: [])
   * @param questId - Optional existing quest ID to use instead of creating new one
   * @param waitForCompletion - If true (default), polls until AI completes. If false, returns
   *   immediately after EventBridge publish - used for async flow where Quest Processor
   *   handles the response and edits the Slack message.
   * @returns AI response text, or null if failed or waitForCompletion=false
   */
  async triggerAIResponseWithContext(
    sessionId: string,
    message: string,
    systemPrompt: string,
    statusCallback?: (status: string) => Promise<void>,
    fabFileIds: string[] = [],
    questId?: string,
    waitForCompletion: boolean = true,
    additionalTools: string[] = []
  ): Promise<string | null> {
    try {
      const { User } = getSlackDb();
      const user = await (User as any).findById(this.user.id);
      if (!user) throw new Error('User not found');

      this.logger.info('[Legacy Path] triggerAIResponseWithContext started', {
        messageLength: message.length,
        hasQuestId: !!questId,
      });

      if (statusCallback) await statusCallback(`${createLoadingBar(20)} Processing your message...`);

      // systemPrompt is the single source of all system-level content
      // (navigate_view guard, pending action context, Slack conversation context, etc.)
      // assembled by the caller (events.ts) before being passed here.
      const extraContextMessages: Array<{ role: 'system'; content: string }> = systemPrompt?.trim()
        ? [{ role: 'system' as const, content: systemPrompt }]
        : [];

      if (statusCallback) await statusCallback(`${createLoadingBar(40)} Getting AI response...`);

      const { chatCompletionDefaults, eventBus } = getSlackDeps();
      // any: defaultChatCompletionOptions provides remaining IChatCompletionServiceOptions fields at runtime
      const chatCompletion = new ChatCompletionInvoke({
        ...chatCompletionDefaults.defaultChatCompletionOptions,
        queue: new SQSService(), // Create per-request for fresh credentials
        tokenizer: chatCompletionDefaults.getSharedTokenizer(this.logger),
        user,
        sessionId,
        logger: this.logger,
        invokeLambda: async (params: unknown) => {
          Logger.globalInstance.log('🌍 [SERVER] CommandHandler Invoking QuestProcessor:', new Date().toISOString());

          await eventBus.LLMEvents.CompletionStart.publish(params);

          Logger.globalInstance.log('🌍 [SERVER] CommandHandler invokeLambda end:', new Date().toISOString());
        },
      } as any);

      // Resolve model config: channel -> agent -> org -> system fallback
      const { modelId, temperature: agentTemperature, maxTokens: agentMaxTokens } = await this.resolveModelConfig();

      // Trigger AI response with context, using existing quest if provided
      const quest = await chatCompletion.invoke({
        body: {
          params: {
            model: modelId,
            temperature: agentTemperature,
            top_p: 1,
            n: 1,
            stream: false,
            max_tokens: agentMaxTokens,
            presence_penalty: 0,
            frequency_penalty: 0,
            logit_bias: {},
          },
          sessionId,
          message,
          messageFileIds: [],
          historyCount: HISTORY_COUNT,
          fabFileIds: fabFileIds, // Pass Slack file attachments
          dashboardParams: {
            dashboardDataSources: [],
          },
          questId: questId, // Use existing quest instead of creating a new one
          extraContextMessages: extraContextMessages.length > 0 ? extraContextMessages : undefined, // Pass system prompt + Slack context as structured messages
          enableQuestMaster: false,
          enableMementos: false,
          enableArtifacts: false,
          enableAgents: true,
          tools: [
            'slackbot_help',
            'list_curated_files',
            'share_curated_file',
            'notebook_new',
            'notebook_status',
            'image_generation',
            ...additionalTools,
          ],
          enableSlackTools: true,
          organizationId: user.organizationId?.toString(), // Include for team-wide system prompts
          allowedAgents: this.parsedCommand?.agentName
            ? PERSONA_ALLOWED_SUBAGENTS[this.parsedCommand.agentName]
            : undefined,
        },
        userId: this.user.id,
      });

      if (!quest) return null;

      // For async flow: return immediately after triggering (EventBridge publish completed)
      // Quest Processor will handle the response and edit the Slack message
      if (!waitForCompletion) {
        this.logger.info('🔔 [ASYNC-TRIGGER] AI triggered successfully, returning early', {
          questId: quest.id,
        });
        return null;
      }

      if (statusCallback) await statusCallback(`${createLoadingBar(60)} Waiting for AI to finish...`);

      // Wait for the quest to complete (with timeout)
      const maxWaitTime = 120000; // 2 minutes
      const pollInterval = 1000; // 1 second
      let elapsedTime = 0;

      while (elapsedTime < maxWaitTime) {
        // Re-fetch the quest to check its status
        const updatedQuest = await chatCompletion.db.quests.findById(quest.id);

        if (updatedQuest?.status === 'done') {
          if (statusCallback) await statusCallback(`${createLoadingBar(80)} Finalizing response...`);

          // Return the first reply if available
          const response = updatedQuest.replies?.[0] || updatedQuest.reply || null;

          // If no response but has pendingAction, that's OK - the preview will be built from pendingAction
          if (!response && updatedQuest.pendingAction) {
            return 'Preparing preview...'; // Placeholder - events.ts will build actual preview
          }

          return response;
        }

        if (updatedQuest?.type === 'error') {
          this.logger.error('Quest failed:', updatedQuest.reply);
          return 'Sorry, I encountered an error processing your request.';
        }

        // Wait before polling again
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        elapsedTime += pollInterval;
      }

      this.logger.warn('AI response timed out');
      return 'Sorry, I took too long to respond. Please try again.';
    } catch (error) {
      this.logger.error('Error triggering AI response:', error);
      return 'Sorry, I encountered an error processing your request.';
    }
  }

  /**
   * Process Slack file attachments and create FAB files
   * Returns array of FAB file IDs and metadata for AI context
   * Handles errors gracefully - skips unsupported files with user notification
   */
  async processSlackFiles(
    files: SlackEventData['files'],
    statusCallback?: (status: string) => Promise<void>
  ): Promise<{
    fabFileIds: string[];
    fileMetadata: Array<{ fabFileId: string; filename: string; mimeType: string; sizeBytes: number }>;
    errors: string[];
  }> {
    if (!files || files.length === 0) {
      return { fabFileIds: [], fileMetadata: [], errors: [] };
    }

    const fabFileIds: string[] = [];
    const fileMetadata: Array<{ fabFileId: string; filename: string; mimeType: string; sizeBytes: number }> = [];
    const errors: string[] = [];

    // File size limits (in bytes)
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
    const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB for images

    const { SupportedFabFileMimeTypes } = await import('@bike4mind/common');

    const SUPPORTED_TYPES: string[] = [
      // Documents
      SupportedFabFileMimeTypes.PDF,
      SupportedFabFileMimeTypes.DOCX,
      SupportedFabFileMimeTypes.XLS,
      SupportedFabFileMimeTypes.XLSX,
      SupportedFabFileMimeTypes.TXT_PLAIN,
      SupportedFabFileMimeTypes.TXT_MARKDOWN,
      SupportedFabFileMimeTypes.TXT_MD_LEGACY,

      // Images
      SupportedFabFileMimeTypes.PNG,
      SupportedFabFileMimeTypes.JPG,
      SupportedFabFileMimeTypes.WEBP,
      SupportedFabFileMimeTypes.GIF,
    ];

    for (const file of files) {
      try {
        // Slack may send partial file objects (e.g. pending/deleted files) where
        // required fields are absent. Skip silently - this is a Slack infrastructure
        // artifact, not a user-chosen file, so no user-facing message is needed.
        if (!file.mimetype || !file.name || !file.url_private_download || file.size === undefined) {
          this.logger.warn('[Slack Files] Skipping file with incomplete data', { fileId: file.id });
          continue;
        }

        // Validate file type
        if (!SUPPORTED_TYPES.includes(file.mimetype)) {
          const error = `⚠️ File "${file.name}" has unsupported type ${file.mimetype}. Skipping.`;
          this.logger.warn(error);
          errors.push(error);
          continue;
        }

        // Validate file size
        const maxSize = file.mimetype.startsWith('image/') ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
        if (file.size > maxSize) {
          const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
          const maxMB = (maxSize / (1024 * 1024)).toFixed(0);
          const error = `⚠️ File "${file.name}" (${sizeMB}MB) exceeds ${maxMB}MB limit. Skipping.`;
          this.logger.warn(error);
          errors.push(error);
          continue;
        }

        if (statusCallback) {
          await statusCallback(`Downloading file: ${file.name}...`);
        }

        // Download file from Slack
        const fileBuffer = await this.slackClient.downloadFile(file.url_private_download, file.name);

        if (statusCallback) {
          await statusCallback(`Processing file: ${file.name}...`);
        }

        // Upload to S3 storage
        const { storage } = getSlackDeps();
        const filePath = `slack-files/${this.user.id}/${Date.now()}-${file.name}`;
        await storage.filesStorage.upload(fileBuffer, filePath, {
          ContentType: file.mimetype,
        });

        // Create FAB file record in database
        const { FabFile } = getSlackDb();
        const { KnowledgeType, FabFileSourceType } = await import('@bike4mind/common');
        const fabFile = await (FabFile as any).create({
          userId: this.user.id,
          fileName: file.name,
          mimeType: file.mimetype,
          filePath: filePath,
          fileSize: file.size,
          type: KnowledgeType.FILE,
          status: 'complete',
          sourceType: FabFileSourceType.SLACK,
        });

        const fabFileIdStr = fabFile._id.toString();
        fabFileIds.push(fabFileIdStr);
        fileMetadata.push({
          fabFileId: fabFileIdStr,
          filename: file.name,
          mimeType: file.mimetype,
          sizeBytes: file.size,
        });
        this.logger.debug('Successfully created FAB file from Slack attachment', {
          fileName: file.name,
          fabFileId: fabFileIdStr,
          mimeType: file.mimetype,
        });
      } catch (error) {
        const errorMsg = `❌ Failed to process file "${file.name}": ${
          error instanceof Error ? error.message : 'Unknown error'
        }`;
        this.logger.error(errorMsg, error);
        errors.push(errorMsg);
        continue;
      }
    }

    return { fabFileIds, fileMetadata, errors };
  }
}
