/**
 * Parses, validates, and processes agent commands from Slack messages.
 */

import { SQSService, checkStorageLimitForFile } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { PERSONA_ALLOWED_SUBAGENTS } from '@bike4mind/agents';
import { SYSTEM_MODEL_DEFAULTS } from './constants/system-model-defaults';
export { SYSTEM_MODEL_DEFAULTS };
import { parseCommand, selectAgent, type ParsedAgentCommand, type AgentPersona } from './agent-parser';
import { customAgentToPersona } from './custom-agent-adapter';
import { SlackEvent, type SlackEventData } from './SlackEvent';
import { validateSlackFileForIngest } from './slackFileValidation';
import { Types } from 'mongoose';
import { updateUserSlackSettings } from './handlers/notebook-manager';
import { getSlackDeps, getSlackDb } from './di/registry';
import { notebookNew } from './tools/notebookNew';
import { notebookStatus } from './tools/notebookStatus';
import {
  HTTPError,
  IUserDocument,
  BadRequestError,
  type IAdminSettingsRepository,
  type IOrganizationDocument,
} from '@bike4mind/common';
import type { SlackMessage } from './thread-intelligence/types';

const HISTORY_COUNT = 20;
// A curated failure reply from ChatCompletionProcess is always short; an unclassified
// internal error message (the raw err.message fallback - see isHttpError below) is the
// one case worth bounding before it reaches a whole Slack channel.
const MAX_ERROR_REPLY_LENGTH = 300;

import { SlackClient } from './SlackClient';
import { ChatCompletionInvoke } from '@bike4mind/services';
import { createLoadingBar } from './utils/loadingBar';

/**
 * `error instanceof HTTPError` is unreliable across the @bike4mind/services ->
 * @bike4mind/slack package boundary if @bike4mind/common ever resolves as two distinct
 * module realms - the same reason `isZodError` and `isChunkClaimLostError`
 * (b4m-core/common/src/errors.ts) avoid a bare instanceof. Duck-type on `statusCode`,
 * which every HTTPError subclass sets, as a realm-safe fallback.
 */
function isHttpError(err: unknown): err is HTTPError {
  return err instanceof HTTPError || typeof (err as { statusCode?: unknown } | null)?.statusCode === 'number';
}

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
          // updatedQuest.reply is the curated message for ChatCompletionProcess's named
          // categories (credits, timeout, tool-pairing, overload, context overflow) - but
          // it sets quest.reply to the raw err.message BEFORE that categorization runs, so
          // an uncategorized failure leaves the raw message in place, and nothing on the
          // quest distinguishes the two cases. Surface it (instead of always flattening to
          // the same string) but cap the length: a curated message is always short, so this
          // only bites the unclassified case, keeping a large/unexpected internal error from
          // dumping wholesale into a Slack channel that may not be private.
          if (!updatedQuest.reply) return 'Sorry, I encountered an error processing your request.';
          return updatedQuest.reply.length > MAX_ERROR_REPLY_LENGTH
            ? `${updatedQuest.reply.slice(0, MAX_ERROR_REPLY_LENGTH)}...`
            : updatedQuest.reply;
        }

        // Wait before polling again
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        elapsedTime += pollInterval;
      }

      this.logger.warn('AI response timed out');
      return 'Sorry, I took too long to respond. Please try again.';
    } catch (error) {
      this.logger.error('Error triggering AI response:', error);
      // HTTPError subclasses (BadRequestError, ForbiddenError, InternalServerError, ...)
      // are thrown with a message already written to be shown to the caller - surface it
      // so a future failure names what broke. Anything else stays generic rather than
      // leaking an unreviewed internal error message to a public Slack channel.
      if (isHttpError(error) && error.message) {
        return error.message;
      }
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

    // Enforce the same MaxFileSize + storage limits fabFilesService.createFabFile applies on
    // the web upload path (#1685): this path writes the FabFile directly and never called that
    // service, so neither limit applied here before. Resolved once per message, not per
    // attachment - neither the admin setting nor the org lookup below can change mid-call.
    const { adminSettingsRepository, FabFile } = getSlackDb();
    // Typed once here, at the DI boundary, instead of `any`-cast at each use below: dropping the
    // `.exec()` on the memoized lookup then becomes a compile error rather than a runtime
    // "Query was already executed" throw on an org-affiliated user's second attachment (the
    // exact bug the round-2 fix caught). `.select(...)` narrows the round-trip to the two fields
    // checkStorageLimitForFile actually reads, instead of pulling the whole organization doc.
    const { Organization } = getSlackDb() as unknown as {
      Organization: {
        findById(id: string): {
          select(fields: string): {
            lean(): { exec(): Promise<Pick<IOrganizationDocument, 'storageLimit' | 'currentStorageSize'> | null> };
          };
        };
      };
    };
    const { storage } = getSlackDeps();
    // Resolved outside the per-file try/catch below, so a lookup failure here is caught on its
    // own (mirroring resolveModelConfig's DB-failure fallback above) instead of propagating out
    // of processSlackFiles entirely - this method never threw before #1685 added this check.
    let maxFileSizeBytes: number | undefined;
    try {
      // any: ISlackDatabaseDependencies types repositories as `unknown` at the DI boundary;
      // the bound implementation (slackPackageInit.ts) is the real IAdminSettingsRepository.
      const maxFileSizeMB = await (adminSettingsRepository as any as IAdminSettingsRepository).getSettingsValue(
        'MaxFileSize'
      );
      maxFileSizeBytes = typeof maxFileSizeMB === 'number' ? maxFileSizeMB * 1024 * 1024 : undefined;
    } catch (settingsError) {
      // Fails open (no MaxFileSize limit for this call) rather than blocking every attachment -
      // the real storage-quota check below still runs regardless.
      this.logger.error('[Slack Files] Failed to resolve MaxFileSize setting, proceeding without it', {
        error: settingsError,
      });
    }
    // Memoized rather than resolved eagerly: most messages carry no attachment that actually
    // needs the storage check, so this only pays for the lookup the first time it is used.
    // Deliberately NOT fail-open like the MaxFileSize lookup above: a rejected lookup stays
    // memoized as the rejection, so every attachment in the message that needs it fails the
    // same way. Unlike an absent MaxFileSize, there is no safe "no limit" fallback for a
    // storage check we could not actually run.
    let organizationLookup:
      Promise<Pick<IOrganizationDocument, 'storageLimit' | 'currentStorageSize'> | null> | undefined;
    const findOrganizationOnce = (id: string) => {
      // `.exec()` is load-bearing: `.lean()` alone returns a thenable Mongoose Query, not a
      // Promise - memoizing the Query itself and awaiting it more than once throws "Query was
      // already executed" on the second await, which is exactly what happens for an
      // org-affiliated user with 2+ attachments in one message (checkStorageLimitForFile awaits
      // this once per accepted attachment). Typed on `Organization` above, so removing `.exec()`
      // is now a compile error instead of a runtime throw.
      organizationLookup ??= Organization.findById(id).select('storageLimit currentStorageSize').lean().exec();
      // TS can't narrow a closed-over variable past `??=` on its own - it is always assigned
      // by this point. checkStorageLimitForFile only reads the two selected fields, so the lean
      // projection satisfies it despite not being a full Mongoose document.
      return organizationLookup as Promise<IOrganizationDocument | null>;
    };
    // `this.user`/the org doc's `currentStorageSize` is a snapshot taken once for this whole
    // call - it is only updated asynchronously later via the S3 `objectCreated` event, not as
    // attachments are accepted here. Tracking bytes accepted so far in THIS message and adding
    // them to each subsequent check keeps a user right at quota from overshooting it by
    // attaching several files in one message that would each individually pass against the
    // stale snapshot.
    let acceptedBytesThisMessage = 0;

    for (const rawFile of files) {
      try {
        const validation = validateSlackFileForIngest(rawFile);
        if (!validation.ok) {
          // An incomplete file object is Slack's artifact, not the user's choice, so it stays a
          // silent log; the other rejections are about a file the user actually picked.
          if (validation.reason === 'incomplete') {
            this.logger.warn('[Slack Files] Skipping file with incomplete data', { fileId: rawFile.id });
            continue;
          }
          // Warning sign, escaped so this source file stays ASCII.
          const error = `\u26a0\ufe0f ${validation.message} Skipping.`;
          this.logger.warn(error);
          errors.push(error);
          continue;
        }
        const { file, resolvedMimeType } = validation;

        // Checked against Slack's CLAIMED size before downloading - mirrors
        // dataLakeFileIngest.ts's own "before it is downloaded" reasoning: an over-limit file
        // would otherwise be transferred in full for nothing. Re-checked below against the real
        // buffer length, since a lying client's claim must not be the actual enforcement.
        if (maxFileSizeBytes !== undefined && file.size >= maxFileSizeBytes) {
          const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
          const limitMB = (maxFileSizeBytes / (1024 * 1024)).toFixed(0);
          // Warning sign, escaped so this source file stays ASCII.
          const error = `\u26a0\ufe0f File "${file.name}" (${sizeMB}MB) exceeds ${limitMB}MB limit. Skipping.`;
          this.logger.warn(error);
          errors.push(error);
          continue;
        }

        if (statusCallback) {
          await statusCallback(`Downloading file: ${file.name}...`);
        }

        // Download file from Slack
        const fileBuffer = await this.slackClient.downloadFile(file.url_private_download, file.name);

        if (maxFileSizeBytes !== undefined && fileBuffer.length >= maxFileSizeBytes) {
          const sizeMB = (fileBuffer.length / (1024 * 1024)).toFixed(1);
          const limitMB = (maxFileSizeBytes / (1024 * 1024)).toFixed(0);
          // Warning sign, escaped so this source file stays ASCII.
          const error = `\u26a0\ufe0f File "${file.name}" (${sizeMB}MB) exceeds ${limitMB}MB limit. Skipping.`;
          this.logger.warn(error);
          errors.push(error);
          continue;
        }

        try {
          // Adding `acceptedBytesThisMessage` folds in every file already accepted earlier in
          // this same loop, so the check is against "quota used so far, including this
          // message" rather than the stale start-of-call snapshot alone.
          await checkStorageLimitForFile(
            this.user,
            fileBuffer.length + acceptedBytesThisMessage,
            this.user.organizationId ?? undefined,
            findOrganizationOnce
          );
        } catch (limitError) {
          // Only a `BadRequestError` (the three thrown by checkStorageLimitForFile/
          // checkOrganizationStorageLimit in @bike4mind/utils) is safe to post verbatim to
          // Slack. Anything else - notably whatever the memoized `Organization.findById(...)`
          // lookup throws on a DB blip - is an internal error (can name a host/port) and must
          // not be echoed into a customer channel.
          if (!(limitError instanceof BadRequestError)) {
            this.logger.error('[Slack Files] Storage limit check failed', { error: limitError, fileName: file.name });
          }
          const message =
            limitError instanceof BadRequestError ? limitError.message : 'Could not verify your storage limit';
          const error = `\u26a0\ufe0f ${message}. Skipping "${file.name}".`;
          this.logger.warn(error);
          errors.push(error);
          continue;
        }

        if (statusCallback) {
          await statusCallback(`Processing file: ${file.name}...`);
        }

        // Upload to S3 storage
        const filePath = `slack-files/${this.user.id}/${Date.now()}-${file.name}`;
        await storage.filesStorage.upload(fileBuffer, filePath, {
          // resolvedMimeType, not the client's claim - a file that only passed the gate because
          // its extension resolved to a supported type must not have an arbitrary/wrong
          // Content-Type header written to S3 (e.g. an attachment that claims text/html on a
          // real .png would otherwise let the object render as HTML from the bucket origin).
          ContentType: resolvedMimeType,
        });

        // Create FAB file record in database
        const { KnowledgeType, FabFileSourceType } = await import('@bike4mind/common');
        const fabFile = await (FabFile as any).create({
          userId: this.user.id,
          fileName: file.name,
          // Persist what the checks above actually verified, not the client's claim: the
          // resolved (extension-based) type, and the real downloaded byte count. A client that
          // under-reports its claimed size would otherwise pass both size checks (the real
          // buffer is checked too) yet permanently undercount this file's recorded fileSize.
          mimeType: resolvedMimeType,
          filePath: filePath,
          fileSize: fileBuffer.length,
          type: KnowledgeType.FILE,
          status: 'complete',
          sourceType: FabFileSourceType.SLACK,
          // Same origin pair the data-lake ingest stamps, so an attachment that arrived through the
          // plain path is auditable the same way rather than only being labelled "from Slack".
          // `channel` is '' on an event that carries none; the field is Mixed, so it round-trips.
          sourceMetadata: { channel: this.slackEvent.channel, messageTs: this.slackEvent.ts },
        });

        // Only charged against quota once the file is actually persisted - a file that fails
        // upload or create must not eat into the headroom the next attachment in this same
        // message is checked against.
        acceptedBytesThisMessage += fileBuffer.length;

        const fabFileIdStr = fabFile._id.toString();
        fabFileIds.push(fabFileIdStr);
        fileMetadata.push({
          fabFileId: fabFileIdStr,
          filename: file.name,
          mimeType: resolvedMimeType,
          sizeBytes: fileBuffer.length,
        });
        this.logger.debug('Successfully created FAB file from Slack attachment', {
          fileName: file.name,
          fabFileId: fabFileIdStr,
          mimeType: resolvedMimeType,
        });
      } catch (error) {
        const errorMsg = `\u274c Failed to process file "${rawFile.name}": ${
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
