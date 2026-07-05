import { BaseStorage } from '@bike4mind/utils';
import {
  getLlmByModel,
  getAvailableModels,
  resolveDeprecatedModelId,
  type ApiKeyTable,
  type ICompletionOptions,
} from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import {
  ISessionAgentConfigDocument,
  IChatHistoryItem,
  IAgentDocument,
  ISessionDocument,
  IChatHistoryItemRepository,
  ISessionRepository,
  ISessionAgentConfigRepository,
  IMessage,
  IUserDocument,
  IApiKeyRepository,
  IAdminSettingsRepository,
  ImageModerationIncident,
} from '@bike4mind/common';
import { generateTools } from '../llm';

interface GenerateAndSendProactiveMessageAdapters {
  config: ISessionAgentConfigDocument;
  agent: IAgentDocument;
  session: ISessionDocument;
  user: IUserDocument;
  logger: Logger;
  recentMessages?: IChatHistoryItem[];
  db: {
    quests: IChatHistoryItemRepository;
    sessions: ISessionRepository;
    sessionAgentConfigs: ISessionAgentConfigRepository;
    apiKeys: IApiKeyRepository;
    adminSettings: IAdminSettingsRepository;
    /**
     * Audit-trail repo for images blocked by the image_generation/edit_image tools'
     * moderation gate. Optional - the gate itself is unconditional (constructed
     * inline in the tool); a missing repo only drops the incident audit record.
     */
    imageModerationIncidents?: { record(input: ImageModerationIncident): Promise<unknown> };
  };
  apiKeyTable: ApiKeyTable;
  /**
   * Storage backends used by tools (e.g., image generation/editing, file operations).
   * These should typically be S3-backed implementations provided by the caller.
   */
  storage: BaseStorage;
  imageGenerateStorage: BaseStorage;
}

/**
 * Generates and sends a proactive message from an agent to a session
 * Uses LLM to generate dynamic content based on conversation context and agent configuration
 */
export async function generateAndSendProactiveMessage({
  config,
  agent,
  session,
  user,
  logger,
  recentMessages = [],
  db,
  apiKeyTable,
  storage,
  imageGenerateStorage,
}: GenerateAndSendProactiveMessageAdapters): Promise<void> {
  try {
    logger.info(`Generating proactive message for agent ${agent.name} in session ${session.id}`);

    const messages = buildProactiveMessageMessages({
      agent,
      config,
      session,
      recentMessages,
    });

    // Use the session's last used model, or default to Claude Sonnet
    const model = resolveDeprecatedModelId(session.lastUsedModel || 'claude-sonnet-4-6', 'agentProactiveMessaging');

    const models = await getAvailableModels(apiKeyTable);
    const modelInfo = models.find(m => m.id === model);

    const llm = getLlmByModel(apiKeyTable, {
      modelInfo,
      logger,
      endUserId: user.id,
    });

    if (!llm || !modelInfo) {
      throw new Error(`Invalid LLM backend for model: ${model}`);
    }

    const toolDefinitions = generateTools(
      user.id,
      user,
      logger,
      {
        db: {
          apiKeys: db.apiKeys,
          adminSettings: db.adminSettings,
          // Wires the moderation incident audit trail into the image_generation/
          // edit_image tools' ToolContext.db - the block itself is unconditional regardless
          // of this wiring (see moderateToolImage in the tool implementations).
          imageModerationIncidents: db.imageModerationIncidents,
        },
      },
      storage,
      imageGenerateStorage,
      async () => {
        // Proactive messages do not stream status to clients, so this is a no-op
      },
      async () => {},
      async () => {},
      llm,
      {},
      model
    );

    const tools = Object.values(toolDefinitions);

    const completionOptions: Partial<ICompletionOptions> = {
      temperature: 0.7,
      maxTokens: 2048,
    };

    if (tools && tools.length > 0) {
      completionOptions.tools = tools;
    }

    const proactiveMessageContent = await new Promise<string>((resolve, reject) => {
      const messageChunks: string[] = [];

      llm
        .complete(model, messages, completionOptions, async chunks => {
          try {
            for (const chunk of chunks) {
              if (chunk) {
                messageChunks.push(chunk);
              }
            }
            // callback fires multiple times during streaming; resolve only after
            // the Promise completes, not here
          } catch (error) {
            reject(error);
          }
        })
        .then(() => {
          resolve(messageChunks.join(''));
        })
        .catch(reject);
    });

    logger.info(`Generated LLM proactive message for agent ${agent.name} using ${model}`);
    logger.info(`Proactive message content: ${proactiveMessageContent}`);
    if (!proactiveMessageContent) {
      logger.error(`No proactive message content generated for agent ${agent.name}`);
      throw new Error(`No proactive message content generated for agent ${agent.name}`);
    }

    const now = new Date();

    // Agent message with the proactive content as the reply, so it appears the
    // agent initiated the conversation
    const proactiveMessage: Omit<IChatHistoryItem, 'sessionId'> = {
      type: 'message',
      prompt: `[Proactive message from ${agent.name}]`,
      replies: [proactiveMessageContent],
      timestamp: now,
      agentIds: [agent.id],
    };

    await db.quests.create({
      ...proactiveMessage,
      sessionId: session.id,
    });

    const messageTimestamp = now;
    const latestKnownTimestamp =
      session.lastUpdated && session.lastUpdated > messageTimestamp ? new Date() : messageTimestamp;

    await db.sessions.update({
      id: session.id,
      lastUpdated: latestKnownTimestamp,
      updatedAt: new Date(),
    });

    await db.sessionAgentConfigs.updateLastProactiveMessageAt(session.id, agent.id, now);

    logger.info(`Successfully generated and sent proactive message for agent ${agent.name}`);
  } catch (error) {
    logger.error(`Failed to generate proactive message for agent ${agent.name}:`, error as Error);
    throw error;
  }
}

/**
 * Builds messages array for LLM to generate a proactive message
 */
function buildProactiveMessageMessages({
  agent,
  config,
  session,
  recentMessages,
}: {
  agent: IAgentDocument;
  config: ISessionAgentConfigDocument;
  session: ISessionDocument;
  recentMessages: IChatHistoryItem[];
}): IMessage[] {
  const agentSystemPrompt = agent.systemPrompt || '';
  const proactiveSystemPrompt = config.proactiveMessaging.systemPrompt || '';

  // Build system message combining agent's base system prompt and custom proactive prompt
  let systemPrompt = `You are ${agent.name}.`;

  if (agentSystemPrompt) {
    systemPrompt += `\n\n${agentSystemPrompt}`;
  }

  systemPrompt += `\n\nYou are proactively reaching out to the user to continue the conversation or offer assistance.`;

  if (proactiveSystemPrompt) {
    systemPrompt += `\n\nProactive messaging instructions: ${proactiveSystemPrompt}`;
  } else {
    systemPrompt += `\n\nBe helpful, friendly, and concise. Reference the recent conversation if applicable.`;
  }

  const messages: IMessage[] = [
    {
      role: 'system',
      content: systemPrompt,
    },
  ];

  // Add recent conversation context
  if (recentMessages.length > 0) {
    // Add up to last 5 messages for context
    const contextMessages = recentMessages.slice(-5);

    for (const msg of contextMessages) {
      if (msg.prompt) {
        messages.push({
          role: 'user',
          content: msg.prompt,
        });
      }
      if ((msg.replies || []).length > 0) {
        messages.push({
          role: 'assistant',
          content: (msg.replies || []).join('\n\n'),
        });
      }
    }

    messages.push({
      role: 'user',
      content:
        'Based on our conversation, please send me a proactive message to continue our discussion or offer assistance.',
    });
  } else {
    // First message - introduce yourself
    messages.push({
      role: 'user',
      content: 'Please introduce yourself and offer your assistance to the user.',
    });
  }

  return messages;
}
