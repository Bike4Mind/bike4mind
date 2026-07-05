import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { agentRepository, imageModerationIncidentRepository } from '@bike4mind/database';
import { ImageModels, IAgent, ModelInfo } from '@bike4mind/common';
import {
  NotFoundError,
  ForbiddenError,
  BadRequestError,
  getSettingsByNames,
  getSettingsMap,
  getSettingsValue,
  RekognitionImageModerationService,
  ImageModerationBlockedError,
} from '@bike4mind/utils';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { apiKeyService, moderateImageOrThrow } from '@bike4mind/services';
import { apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { OperationsModelService } from '@client/services/operationsModelService';

import { KnowledgeType } from '@bike4mind/common';
import { fabFileRepository } from '@bike4mind/database';
import axios from 'axios';
import imageLogger from '@client/app/utils/imageLogger';

// System prompt for creating visual prompts from agent descriptions
const AGENT_AVATAR_PROMPT_SYSTEM = `You are an expert at translating rich personality descriptions and agent metadata into detailed visual prompts for AI image generation.

Your task is to analyze the agent's description and metadata, then create a compelling visual prompt that captures their essence as a portrait/avatar image.

Guidelines:
1. Focus on creating a portrait/headshot/upper body composition
2. Translate personality traits into visual characteristics (expressions, styling, mood)
3. Include relevant visual elements that reflect their mission, values, and personality
4. Consider their cultural flavor, energy level, and communication style
5. Make it feel authentic to who they are as a being with agency and purpose
6. Include appropriate lighting, mood, and artistic style directions
7. Be specific about facial expressions that match their personality
8. Consider their professional context while maintaining personality

Create a detailed image generation prompt (2-3 sentences) that would produce an engaging avatar/portrait that users would immediately recognize as "this agent" based on their personality and mission.

Focus on: facial expression, styling, mood, background elements, lighting, and artistic approach that matches their identity.`;

interface AgentAvatarRequest {
  imageModel?: string;
}

interface AgentAvatarResponse {
  portraitUrl: string;
  generationPrompt: string;
}

const buildAgentVisualPrompt = (agent: IAgent): string => {
  const context = [];

  // Agent Name and Description (primary source)
  context.push(`Agent Name: ${agent.name}`);
  if (agent.description) {
    context.push(`\nAgent Description:\n${agent.description}`);
  }

  // Identity & Visual Style
  if (agent.identity) {
    if (agent.identity.gender !== 'prefer-not-to-say') {
      context.push(`\nGender Identity: ${agent.identity.gender}`);
    }
  }

  if (agent.visual?.style) {
    context.push(`Preferred Visual Style: ${agent.visual.style}`);
  }

  // Key Personality Elements for Visual Translation
  if (agent.personality) {
    context.push(`\n=== PERSONALITY FOR VISUAL TRANSLATION ===`);

    if (agent.personality.majorMotivation) {
      context.push(`Major Motivation: ${agent.personality.majorMotivation}`);
    }
    if (agent.personality.quirk) {
      context.push(`Unique Quirk: ${agent.personality.quirk}`);
    }
    if (agent.personality.energyLevel) {
      context.push(`Energy Level: ${agent.personality.energyLevel}`);
    }
    if (agent.personality.culturalFlavor) {
      context.push(`Cultural Flavor: ${agent.personality.culturalFlavor}`);
    }
    if (agent.personality.communicationPattern) {
      context.push(`Communication Style: ${agent.personality.communicationPattern}`);
    }
    if (agent.personality.personalMission) {
      context.push(`Personal Mission: ${agent.personality.personalMission}`);
    }
    if (agent.personality.coreValues) {
      context.push(`Core Values: ${agent.personality.coreValues}`);
    }
  }

  // Current visual info (if any)
  if (agent.visual?.generationPrompt) {
    context.push(`\nPrevious Visual Prompt: ${agent.visual.generationPrompt}`);
  }

  const contextString = context.join('\n');

  return `Based on the following agent information, create a detailed visual prompt for generating their portrait/avatar image:

${contextString}

Generate a detailed image prompt that would create an engaging portrait/avatar that captures this agent's unique personality, mission, and visual identity. Focus on portrait composition with appropriate styling, expression, and mood.`;
};

// Function to download image from URL and convert to buffer
const downloadImageBuffer = async (imageUrl: string): Promise<Buffer> => {
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  return Buffer.from(response.data);
};

const handler = baseApi().post<Request<{ id: string }, AgentAvatarResponse, AgentAvatarRequest>>(async (req, res) => {
  const { id } = req.query;
  const userId = req.user!.id;
  const { imageModel: userImageModel } = req.body;

  // Validate the id parameter
  if (!id || typeof id !== 'string') {
    throw new BadRequestError('Invalid agent ID');
  }

  // Find the agent
  const agent = await agentRepository.findById(id);
  if (!agent) {
    throw new NotFoundError('Agent not found');
  }

  // Check ownership
  if (agent.userId !== userId) {
    throw new ForbiddenError("You don't have permission to modify this agent");
  }

  try {
    // Get operations model for text generation (LLM for prompt generation)
    const { modelId, llm } = await OperationsModelService.getOperationsModel();

    if (!llm) {
      throw new Error('Failed to initialize text model for prompt generation');
    }

    // Determine which image model to use
    // Priority: user's selected model > operations model
    let imageModelId: string;
    let imageModelInfo: ModelInfo | undefined;

    if (userImageModel) {
      // User specified an image model - use it
      const dbAdapters = {
        db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
        getSettingsByNames,
      };
      const coreKeys = await apiKeyService.getEffectiveLLMApiKeys(userId, dbAdapters);
      const apiKeyTable = {
        openai: coreKeys.openai || undefined,
        anthropic: coreKeys.anthropic || undefined,
        gemini: coreKeys.gemini || undefined,
        bfl: coreKeys.bfl || undefined,
        ollama: coreKeys.ollama || undefined,
        xai: coreKeys.xai || undefined,
      };
      const models = await getAvailableModels(apiKeyTable);
      // Validate that the model exists AND is an image model
      imageModelInfo = models.find(m => m.id === userImageModel && m.type === 'image');

      if (!imageModelInfo) {
        throw new BadRequestError(
          `Image model "${userImageModel}" not available or is not an image model. Please select a valid image model.`
        );
      }

      imageModelId = userImageModel;
      imageLogger.info(`Using user-selected image model: ${imageModelId}`);
    } else {
      // Fall back to operations model
      const operationsResult = await OperationsModelService.getOperationsModel();
      imageModelId = operationsResult.imageModelId;
      imageModelInfo = operationsResult.imageModelInfo;

      if (!imageModelId || !imageModelInfo) {
        throw new BadRequestError(
          'No image generation model available. Please configure an image model in operations settings.'
        );
      }
      imageLogger.info(`Using operations image model: ${imageModelId}`);
    }

    imageLogger.info(`Generating avatar for agent ${agent.name}`, {
      textModel: modelId,
      imageModel: imageModelId,
      imageBackend: imageModelInfo.backend,
    });

    const userPrompt = buildAgentVisualPrompt(agent);
    let generatedPrompt = '';

    await llm.complete(
      modelId,
      [
        { role: 'system', content: AGENT_AVATAR_PROMPT_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      {
        temperature: 0.8, // Creative but controlled
        maxTokens: 300,
        stream: false,
      },
      async (texts: (string | null | undefined)[]) => {
        if (texts[0]) {
          generatedPrompt += texts[0];
        }
      }
    );

    if (!generatedPrompt.trim()) {
      throw new Error('Failed to generate visual prompt');
    }

    let cleanPrompt = generatedPrompt.trim();
    imageLogger.info(`Generated visual prompt: ${cleanPrompt.substring(0, 100)}...`);

    // Handle prompt length limits for different models
    if (imageModelId === ImageModels.GPT_IMAGE_1 && cleanPrompt.length > 1000) {
      const originalLength = cleanPrompt.length;
      // Truncate to 980 characters to leave some buffer
      cleanPrompt = cleanPrompt.substring(0, 980) + '...';
      imageLogger.warn(`Truncated prompt for GPT-Image-1: ${originalLength} → ${cleanPrompt.length} characters`);
    }

    // Step 2: Generate the image using the visual prompt directly with the service
    // We'll use the aiImageService directly instead of the full ImageGenerationService

    // Determine optimal parameters based on model
    const imageParams: any = {
      model: imageModelId,
      n: 1,
      user: userId,
    };

    if (imageModelId === ImageModels.GPT_IMAGE_1) {
      // GPT-Image-1 optimal settings
      imageParams.size = '1024x1024'; // Largest supported
      imageParams.quality = 'high';
    } else if (imageModelId.startsWith('flux-')) {
      // BFL models optimal settings
      imageParams.width = 1024;
      imageParams.height = 1024; // Square for avatar
      imageParams.safety_tolerance = 4; // Balanced
      imageParams.output_format = 'png';
      imageParams.prompt_upsampling = true; // Better quality
    }

    // Get API keys for the image generation
    const dbAdapters = {
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      getSettingsByNames,
    };
    const coreKeys = await apiKeyService.getEffectiveLLMApiKeys(userId || 'system', dbAdapters);
    // Convert to ApiKeyTable format for backward compatibility
    const apiKeyTable = {
      openai: coreKeys.openai || undefined,
      anthropic: coreKeys.anthropic || undefined,
      gemini: coreKeys.gemini || undefined,
      bfl: coreKeys.bfl || undefined,
      ollama: coreKeys.ollama || undefined,
      xai: coreKeys.xai || undefined,
    };

    // Use the existing image generation process
    imageLogger.info(`Using model ${imageModelId} with API keys available:`, {
      hasOpenAI: !!apiKeyTable.openai,
      hasBFL: !!apiKeyTable.bfl,
      selectedBackend: imageModelId.startsWith('flux-') ? 'BFL' : 'OpenAI',
    });

    // Import the aiImageService function
    const { aiImageService } = await import('@bike4mind/utils');

    // Choose the appropriate service based on the model backend
    const isBFLModel = imageModelId.startsWith('flux-');

    // Final validation before service creation
    if (isBFLModel && !apiKeyTable.bfl) {
      throw new Error('BFL model selected but no BFL API key available');
    }
    if (!isBFLModel && !apiKeyTable.openai) {
      throw new Error('OpenAI model selected but no OpenAI API key available');
    }

    const imageService = isBFLModel
      ? aiImageService('bfl', apiKeyTable.bfl!, req.logger)
      : aiImageService('openai', apiKeyTable.openai!, req.logger);

    imageLogger.info(`Generating with ${imageModelId} using ${isBFLModel ? 'BFL' : 'OpenAI'} service:`, imageParams);
    const generatedImages = await imageService.generate(cleanPrompt, imageParams);

    if (!generatedImages || generatedImages.length === 0) {
      throw new Error('No images were generated');
    }

    const imageUrl = generatedImages[0];
    imageLogger.info(`Generated image URL: ${imageUrl.substring(0, 100)}...`);

    // Step 3: Download the image and store it properly as a FabFile
    imageLogger.info(`Downloading and storing generated image...`);

    // Declare updatedAgent with fallback value
    let updatedAgent = {
      ...agent,
      visual: {
        ...agent.visual,
        portraitUrl: imageUrl, // Default to temporary URL
        generationPrompt: cleanPrompt,
      },
    };

    try {
      // Download the image from the provider
      const imageBuffer = await downloadImageBuffer(imageUrl);

      // Moderate the freshly generated avatar before it's ever uploaded or
      // returned. The server has the bytes in hand right here, so (unlike an uploaded
      // file, which is presigned direct-to-S3 and scanned asynchronously by objectCreated)
      // this check runs synchronously and gates storage/response entirely. On a confirmed
      // block this throws `ImageModerationBlockedError`, which the catch below rethrows
      // immediately (rather than falling back to the temporary provider URL) so nothing
      // is uploaded, no FabFile is created, and no image URL (signed or temporary) is
      // ever returned to the client.
      const moderationSettings = await getSettingsMap({ adminSettings: adminSettingsRepository });
      await moderateImageOrThrow({
        service: new RekognitionImageModerationService(req.logger),
        enabled: getSettingsValue('ImageModerationEnabled', moderationSettings) ?? true,
        incidents: imageModerationIncidentRepository,
        buffer: imageBuffer,
        mimeType: 'image/png',
        incidentMeta: { userId, provider: 'avatar', model: 'avatar' },
        logger: req.logger,
      });

      // Create a unique filename for the avatar
      const fileName = `agent-${agent.id}-avatar-${Date.now()}.png`;
      const filePath = fileName; // Simple filename without directories

      // Import storage service
      const { getFilesStorage } = await import('@server/utils/storage');

      // Upload to S3 (returns just the file path)
      const uploadedPath = await getFilesStorage().upload(imageBuffer, filePath, { ContentType: 'image/png' });

      if (!uploadedPath) {
        throw new Error('Failed to upload generated image to storage');
      }

      // Generate a signed URL for accessing the uploaded image
      const uploadedUrl = await getFilesStorage().getSignedUrl(uploadedPath, 'get', { expiresIn: 3600 });

      if (!uploadedUrl) {
        throw new Error('Failed to generate signed URL for uploaded image');
      }

      // Create a FabFile record for the uploaded image
      const fabFileData = {
        fileName,
        filePath: uploadedPath, // This is just the filename
        fileUrl: uploadedUrl, // This is the full signed URL
        fileUrlExpireAt: new Date(Date.now() + 3600 * 1000), // 1 hour from now
        mimeType: 'image/png',
        fileSize: imageBuffer.length,
        type: KnowledgeType.FILE, // Images are stored as FILE type
        userId,
        public: true, // Agent avatars can be public
        // Already moderated synchronously via moderateImageOrThrow above (a
        // confirmed block throws before this point is ever reached), so mark 'clean' up
        // front so the avatar is immediately serveable (isImageServeable gate) instead of
        // defaulting to 'pending' and waiting on objectCreated's async re-scan, where a
        // transient throttle could strand it un-servable. The atomic scan-claim in
        // objectCreated makes that re-scan a no-op once it observes 'clean'.
        moderationStatus: 'clean' as const,
        // Initialize required shareable fields
        groups: [],
        users: [],
        isGlobalRead: true,
        isGlobalWrite: false,
      };

      imageLogger.info(`Creating FabFile record for avatar:`, {
        fileName,
        fileSize: imageBuffer.length,
        filePath: uploadedPath,
        signedUrl: uploadedUrl.substring(0, 100) + '...',
      });

      const fabFile = await fabFileRepository.create(fabFileData);

      if (!fabFile) {
        throw new Error('Failed to create FabFile record for avatar');
      }

      // Use the proper signed URL instead of the temporary provider URL
      const finalImageUrl = uploadedUrl;
      imageLogger.info(`Avatar successfully stored with signed URL: ${finalImageUrl.substring(0, 100)}...`);

      // Update with the signed URL
      updatedAgent = {
        ...agent,
        visual: {
          ...agent.visual,
          portraitUrl: finalImageUrl, // Use the signed URL, not the temporary provider URL
          generationPrompt: cleanPrompt,
        },
      };
    } catch (storageError) {
      // A confirmed moderation block must never fall back to the temporary provider
      // URL below - that fallback exists for genuine storage failures, and reusing it
      // here would leak the blocked image's URL to the client. Propagate to the outer
      // catch so the request fails cleanly with nothing stored or returned.
      if (storageError instanceof ImageModerationBlockedError) {
        throw storageError;
      }

      imageLogger.error('Failed to store avatar image:', storageError);
      // Fall back to using the temporary URL if storage fails
      imageLogger.warn('Falling back to temporary provider URL due to storage failure');
      // updatedAgent already has the fallback value set above
    }

    imageLogger.info(`Updating agent visual data:`, {
      agentId: agent.id,
      agentName: agent.name,
      oldPortraitUrl: agent.visual?.portraitUrl || 'none',
      newPortraitUrl: imageUrl.substring(0, 100) + '...',
      generationPrompt: cleanPrompt.substring(0, 100) + '...',
    });

    const updateResult = await agentRepository.update(updatedAgent);

    if (updateResult) {
      imageLogger.info(`Agent update result:`, {
        agentId: updateResult.id,
        updatedPortraitUrl: updateResult.visual?.portraitUrl?.substring(0, 100) + '...' || 'none',
        updateSuccessful: !!updateResult.visual?.portraitUrl,
      });
    } else {
      imageLogger.error(`Agent update failed - null result returned`);
      throw new Error('Failed to update agent in database');
    }

    imageLogger.info(`Successfully generated and saved avatar for agent ${agent.name}`);

    // Return the final URL that was actually stored in the database
    const finalPortraitUrl = updatedAgent.visual?.portraitUrl || imageUrl;

    res.json({
      portraitUrl: finalPortraitUrl,
      generationPrompt: cleanPrompt,
    });
  } catch (error) {
    imageLogger.error('Error generating agent avatar:', error);

    // Provide user-friendly error messages
    let errorMessage = 'Failed to generate avatar. Please try again.';
    if (error instanceof ImageModerationBlockedError) {
      errorMessage = 'Generated avatar was flagged by content moderation and could not be saved. Please try again.';
    } else if (error instanceof Error) {
      if (error.message.includes('API key') || error.message.includes('model')) {
        errorMessage = 'AI service temporarily unavailable. Please try again later.';
      } else if (error.message.includes('credits')) {
        errorMessage = 'Insufficient credits to generate avatar.';
      } else if (error.message.includes('upload')) {
        errorMessage = 'Generated avatar but failed to save. Please try again.';
      }
    }

    res.status(500).json({ error: errorMessage });
  }
});

export default handler;
