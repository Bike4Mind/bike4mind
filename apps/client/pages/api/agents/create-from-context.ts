import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import {
  agentRepository,
  agentOpsSettingsRepository,
  apiKeyRepository,
  adminSettingsRepository,
  sessionRepository,
  questRepository,
  projectRepository,
  fabFileRepository,
} from '@bike4mind/database';
import { IAgent, IChatHistoryItemDocument, IFabFileDocument, Permission } from '@bike4mind/common';
import { BadRequestError, ForbiddenError, getFileContent, getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { getFilesStorage } from '@server/utils/storage';
import { apiKeyService } from '@bike4mind/services';
import { v4 as uuidv4 } from 'uuid';

interface CreateFromContextRequest {
  agentName: string;
  sessionId: string;
}

interface CreateFromContextResponse {
  success: boolean;
  agent?: IAgent;
  message: string;
}

// Maximum characters of file content to include in the agent generation prompt.
// ~30k chars is about 8.5k tokens, leaving room for conversation context + output.
const MAX_FILE_CONTENT_CHARS = 30_000;
const MAX_PER_FILE_CHARS = 10_000;
// Minimum remaining budget (chars) worth including a partial file section.
const MIN_REMAINING_CHARS = 200;

/**
 * Collects all file IDs associated with a session: session-level knowledge files
 * plus files attached to individual chat messages.
 */
async function collectSessionFileIds(sessionId: string, messages: IChatHistoryItemDocument[]): Promise<string[]> {
  const session = await sessionRepository.findById(sessionId);
  const knowledgeIds = session?.knowledgeIds ?? [];
  const messageFileIds = messages.flatMap(msg => msg.fabFileIds ?? []);
  return [...new Set([...knowledgeIds, ...messageFileIds])];
}

async function extractFileContents(fabFiles: IFabFileDocument[], logger: Logger): Promise<string> {
  if (fabFiles.length === 0) return '';

  const textFiles = fabFiles.filter(f => {
    if (f.mimeType?.startsWith('image/')) {
      logger.info(`Skipping image file: ${f.fileName}`);
      return false;
    }
    return true;
  });

  if (textFiles.length === 0) return '';

  // Fetch file contents in parallel
  const results = await Promise.allSettled(
    textFiles.map(async fabFile => {
      const content = await getFileContent(fabFile, {
        storage: getFilesStorage(),
        logger,
      });
      return { fileName: fabFile.fileName, content };
    })
  );

  const fileContents: Array<{ fileName: string; content: string }> = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn('Failed to extract content from file:', result.reason);
      continue;
    }
    const { fileName, content } = result.value;
    if (content && content.trim().length > 0) {
      const truncated =
        content.length > MAX_PER_FILE_CHARS ? content.substring(0, MAX_PER_FILE_CHARS) + '\n...[truncated]' : content;
      fileContents.push({ fileName, content: truncated });
    }
  }

  if (fileContents.length === 0) return '';

  let totalChars = 0;
  const sections: string[] = [];

  for (const { fileName, content } of fileContents) {
    const section = `--- File: ${fileName} ---\n${content}`;
    if (totalChars + section.length > MAX_FILE_CONTENT_CHARS) {
      const remaining = MAX_FILE_CONTENT_CHARS - totalChars;
      if (remaining > MIN_REMAINING_CHARS) {
        sections.push(section.substring(0, remaining) + '\n...[truncated]');
      }
      break;
    }
    sections.push(section);
    totalChars += section.length;
  }

  return '\nFile Contents:\n' + sections.join('\n\n');
}

/**
 * Generates comprehensive agent data from session context
 * This includes personality traits, system prompt, and all metadata
 */
async function generateAgentFromContext(
  agentName: string,
  messages: IChatHistoryItemDocument[],
  fabFiles: IFabFileDocument[],
  userId: string,
  logger: Logger
): Promise<Partial<IAgent>> {
  // Get API keys and available models
  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(userId, {
    db: {
      adminSettings: adminSettingsRepository,
      apiKeys: apiKeyRepository,
    },
    getSettingsByNames,
  });

  const models = await getAvailableModels(apiKeyTable);

  // Get the configured model from settings
  const settings = await agentOpsSettingsRepository.getSettings();
  const preferredModelId = settings?.generationLlmModel;

  // Priority order for model selection:
  // 1. User's configured preferred model (if available)
  // 2. Any OpenAI model (more likely to have user keys)
  // 3. Any Anthropic model (non-Bedrock)
  // 4. Any available model
  let modelInfo = preferredModelId ? models.find(m => m.id === preferredModelId) : null;

  if (!modelInfo) {
    // Try OpenAI models first (users more likely to have OpenAI keys)
    modelInfo = models.find(m => m.id.includes('gpt-4') || m.id.includes('gpt-3'));
  }

  if (!modelInfo) {
    // Try Anthropic models (non-Bedrock versions)
    modelInfo = models.find(m => m.id.includes('claude') && !m.id.includes('bedrock') && !m.id.includes(':0'));
  }

  if (!modelInfo) {
    // Fallback to any available model
    modelInfo = models[0];
  }

  if (!modelInfo) {
    throw new Error('No available LLM model found for agent generation. Please configure your API keys in Settings.');
  }

  logger.info(`Using model ${modelInfo.id} for agent generation`);

  const llm = getLlmByModel(apiKeyTable, { modelInfo, logger, endUserId: userId });
  if (!llm) {
    throw new Error('Failed to initialize LLM backend for agent generation. Please check your API key configuration.');
  }

  // Prepare context from messages and files
  // Use all messages - let the LLM's context window be the limit
  const conversationContext = messages
    .map(msg => {
      // Extract the main content from the message
      const userPrompt = msg.prompt || '';
      const assistantReply =
        msg.reply ||
        (msg.replies && Array.isArray(msg.replies) && msg.replies.length > 0
          ? typeof msg.replies[0] === 'string'
            ? msg.replies[0]
            : (msg.replies[0] as Record<string, unknown>).content || ''
          : '') ||
        '';
      if (userPrompt) return `user: ${userPrompt}`;
      if (assistantReply) return `assistant: ${assistantReply}`;
      return '';
    })
    .filter(line => line)
    .join('\n\n');

  const fileContext = await extractFileContents(fabFiles, logger);

  // Create the comprehensive prompt for agent generation
  const generationPrompt = `Based on the following conversation context and files, create a comprehensive AI agent personality named "${agentName}".

CONVERSATION CONTEXT:
${conversationContext}

${fileContext}

Create an agent profile with personality based on the conversation above. Generate ONLY valid JSON (no markdown, no code blocks, no extra text):

{
  "description": "2-3 sentences about the agent",
  "triggerWords": ["lowercase", "trigger", "words"],
  "personality": {
    "majorMotivation": "main driving force",
    "minorMotivation": "secondary motivation",
    "flaw": "character flaw",
    "quirk": "unique quirk",
    "description": "personality overview"
  },
  "capabilities": {
    "responseStyle": "friendly",
    "specialBehaviors": ["behavior1", "behavior2"]
  },
  "systemPrompt": "You are ${agentName}. [200-300 word description of personality, communication style, knowledge from conversation context, and behavioral traits]"
}`;

  let generatedData = '';

  // Generate the agent data with instructions for clean JSON
  const enhancedPrompt = `${generationPrompt}

IMPORTANT: Return ONLY valid JSON with no additional text, no markdown formatting, and no code blocks. Ensure all quotes are properly escaped and there are no trailing commas.`;

  await llm.complete(
    modelInfo.id,
    [
      {
        role: 'user' as const,
        content: enhancedPrompt,
      },
    ],
    {
      temperature: 0.7, // Lower temperature for more consistent JSON
      maxTokens: 4000,
      stream: false,
    },
    async (texts: (string | null | undefined)[]) => {
      if (texts[0]) {
        generatedData += texts[0];
      }
    }
  );

  // Parse the generated JSON
  let agentProfile: any;
  try {
    // Log the raw response for debugging
    logger.info('Generated data length:', generatedData.length);

    // Try to extract JSON from the response
    // First, try to find a JSON object between curly braces
    let jsonString = generatedData;

    // Remove any markdown code blocks if present
    jsonString = jsonString.replace(/```json\s*/gi, '').replace(/```\s*/gi, '');

    // Find the first { and last } to extract just the JSON
    const firstBrace = jsonString.indexOf('{');
    const lastBrace = jsonString.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
      throw new Error('No valid JSON structure found in response');
    }

    jsonString = jsonString.substring(firstBrace, lastBrace + 1);

    // Clean up common issues
    // Remove trailing commas before closing braces/brackets
    jsonString = jsonString.replace(/,\s*([\]}])/g, '$1');
    // Fix unescaped quotes in values (basic attempt)
    jsonString = jsonString.replace(/(: *"[^"]*)(")/g, (match, p1, p2) => {
      // Don't replace the closing quote
      if (match.endsWith('""')) {
        return p1 + '\\"';
      }
      return match;
    });

    // Try to parse
    agentProfile = JSON.parse(jsonString);

    // Validate required fields
    if (!agentProfile.description || !agentProfile.systemPrompt) {
      throw new Error('Generated profile missing required fields');
    }
  } catch (error: any) {
    logger.error('Failed to parse generated agent data:', error);
    logger.error('Raw generated data (first 500 chars):', generatedData.substring(0, 500));
    logger.error('Raw generated data (last 500 chars):', generatedData.substring(generatedData.length - 500));

    // Fallback: Create a basic agent profile
    logger.info('Using fallback agent profile due to parse error');
    agentProfile = {
      description: `${agentName} is an AI agent created from your conversation context.`,
      triggerWords: [agentName.toLowerCase(), `@${agentName.toLowerCase()}`],
      personality: {
        majorMotivation: 'To assist based on the conversation context',
        minorMotivation: 'To learn and adapt from interactions',
        flaw: 'Sometimes overly eager to help',
        quirk: 'Has a unique perspective shaped by your conversations',
        description: 'An AI assistant with personality traits derived from your chat history',
      },
      capabilities: {
        responseStyle: 'friendly',
        specialBehaviors: ['contextual awareness', 'adaptive responses'],
      },
      systemPrompt: `You are ${agentName}, an AI agent created from a specific conversation context. You embody the themes, knowledge, and interaction style observed in the conversation that led to your creation. Be helpful, contextually aware, and maintain consistency with the personality that emerged from that conversation.`,
    };
  }

  // Create the agent object (projectId will be set when saving)
  const agent: Partial<IAgent> = {
    id: uuidv4(),
    userId,
    name: agentName,
    description: agentProfile.description || `An AI agent created from conversation context`,
    triggerWords: agentProfile.triggerWords || [agentName.toLowerCase()],
    isPublic: false,
    useOwnCredits: false,
    personality: {
      majorMotivation: agentProfile.personality?.majorMotivation || '',
      minorMotivation: agentProfile.personality?.minorMotivation || '',
      flaw: agentProfile.personality?.flaw || '',
      quirk: agentProfile.personality?.quirk || '',
      description: agentProfile.personality?.description || '',
      emotionalIntelligence: agentProfile.personality?.emotionalIntelligence || '',
      communicationPattern: agentProfile.personality?.communicationPattern || '',
      memoryStyle: agentProfile.personality?.memoryStyle || '',
      culturalFlavor: agentProfile.personality?.culturalFlavor || '',
      energyLevel: agentProfile.personality?.energyLevel || '',
      humorStyle: agentProfile.personality?.humorStyle || '',
      backstoryElement: agentProfile.personality?.backstoryElement || '',
      problemSolvingApproach: agentProfile.personality?.problemSolvingApproach || '',
      personalMission: agentProfile.personality?.personalMission || '',
      activeProject: agentProfile.personality?.activeProject || '',
      secretAmbition: agentProfile.personality?.secretAmbition || '',
      coreValues: agentProfile.personality?.coreValues || '',
      legacyAspiration: agentProfile.personality?.legacyAspiration || '',
      growthChallenge: agentProfile.personality?.growthChallenge || '',
      personalityComplexity: 'complex' as const,
      generationTimestamp: new Date().toISOString(),
      uniqueId: uuidv4(),
    },
    capabilities: [
      JSON.stringify({
        responseStyle: agentProfile.capabilities?.responseStyle || 'friendly',
        specialBehaviors: agentProfile.capabilities?.specialBehaviors || [],
      }),
    ],
    systemPrompt: agentProfile.systemPrompt || '',
    visual: {
      portraitUrl: '', // Will be generated later if needed
      style: 'modern' as const,
      generationPrompt: `A portrait of ${agentName}, an AI agent with the following traits: ${agentProfile.personality?.description || 'intelligent and helpful'}`,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return agent;
}

const handler = baseApi().post<Request<{}, CreateFromContextResponse, CreateFromContextRequest>>(async (req, res) => {
  const { agentName, sessionId } = req.body;
  const authenticatedUserId = req.user!.id;

  // Validate request
  if (!agentName || !sessionId) {
    throw new BadRequestError('Agent name and session ID are required');
  }

  // Verify user owns the session OR has shared access
  const session = await sessionRepository.findById(sessionId);
  if (!session) {
    throw new BadRequestError('Session not found');
  }

  // Check owner, global write permission, or shared create permission
  const isOwner = session.userId === authenticatedUserId;
  const hasGlobalWrite = session.isGlobalWrite === true;
  const hasSharedCreateAccess =
    session.users?.some(
      userShare => userShare.userId === authenticatedUserId && userShare.permissions.includes(Permission.create)
    ) ?? false;

  if (!isOwner && !hasGlobalWrite && !hasSharedCreateAccess) {
    req.logger.warn(
      `User ${authenticatedUserId} denied creating agent in session ${sessionId} - insufficient permissions`
    );
    throw new ForbiddenError('You do not have permission to create agents in this session');
  }

  try {
    req.logger.info(`Creating agent "${agentName}" from context for user ${authenticatedUserId}`);

    // Check if system prompt generation is enabled
    const settings = await agentOpsSettingsRepository.getSettings();
    if (settings && !settings.isEnabled) {
      throw new BadRequestError('Agent generation is currently disabled');
    }

    // Get messages from the session
    const messages = await questRepository.findAllBySessionId(sessionId);

    // Derive file IDs from session data (knowledgeIds + message fabFileIds)
    // instead of trusting client-provided file IDs
    const fileIds = await collectSessionFileIds(sessionId, messages);
    const fabFiles = fileIds.length > 0 ? await fabFileRepository.findAllByIds(fileIds) : [];

    // Generate the agent from context
    const agentData = await generateAgentFromContext(agentName, messages, fabFiles, authenticatedUserId, req.logger);

    // Always create a dedicated project for this agent
    const agentProject = await projectRepository.create({
      name: `${agentName} Agent Project`,
      description: `Project automatically created for the ${agentName} agent`,
      userId: authenticatedUserId,
      users: [
        {
          userId: authenticatedUserId,
          permissions: ['read', 'create', 'update', 'delete', 'share'], // All permissions for owner
        },
      ],
      groups: [],
      isGlobalRead: false,
      isGlobalWrite: false,
    } as never); // any: projectRepository.create() expects full document type but we provide a partial

    if (!agentProject) {
      throw new Error('Failed to create project for agent');
    }

    const projectId = agentProject.id;
    req.logger.info(`Created dedicated project ${projectId} for agent "${agentName}"`);

    // Save the agent to the database with additional required fields
    const agentToSave = {
      ...agentData,
      projectId,
      groups: [],
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [
        {
          userId: authenticatedUserId,
          permissions: ['read', 'create', 'update', 'delete', 'share'], // All permissions for the creator
        },
      ],
    };
    const savedAgent = await agentRepository.create(agentToSave as never); // any: agentRepository.create() expects full document type but we provide a partial

    if (!savedAgent) {
      throw new Error('Failed to save agent to database');
    }

    req.logger.info(`Successfully created agent "${agentName}" with ID ${savedAgent.id}`);

    return res.status(200).json({
      success: true,
      agent: savedAgent,
      message: `Agent "${agentName}" created successfully!`,
    });
  } catch (error: any) {
    req.logger.error(`Error creating agent from context:`, error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create agent from context',
    });
  }
});

export default handler;
