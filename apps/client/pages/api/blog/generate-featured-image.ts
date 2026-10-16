import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { randomUUID } from 'crypto';
import { ImageModels, ModelInfo, UnprocessableEntityError, usdToCredits } from '@bike4mind/common';
import { BadRequestError, getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { apiKeyService } from '@bike4mind/services';
import { apiKeyRepository, adminSettingsRepository, usageEventRepository } from '@bike4mind/database';
import { OperationsModelService } from '@client/services/operationsModelService';
import imageLogger from '@server/utils/imageLogger';
import axios from 'axios';
import {
  computeImageUsdCostPerImage,
  estimateImageCredits,
  UnsupportedImageModelError,
} from '@bike4mind/services/imageCost';
import { isCreditsEnforced } from '@server/billing/meterPlatformCompletion';
import { reserveRequestCredits } from '@server/billing/reserveRequestCredits';

interface GenerateFeaturedImageRequest {
  imagePrompt: string;
  imageModel?: string;
}

interface GenerateFeaturedImageResponse {
  success: boolean;
  imageUrl: string;
  message?: string;
}

/**
 * Generate a featured image for blog posts using direct image generation.
 * This endpoint waits for the image to be generated (synchronous) rather than
 * queueing the job, making it suitable for the blog publish flow.
 */
const handler = baseApi().post<Request<unknown, GenerateFeaturedImageResponse, GenerateFeaturedImageRequest>>(
  async (req, res) => {
    const userId = req.user!.id;
    const { imagePrompt, imageModel: userImageModel } = req.body;

    if (!imagePrompt?.trim()) {
      throw new BadRequestError('Image prompt is required');
    }

    try {
      let imageModelId: string | null;
      let imageModelInfo: ModelInfo | null | undefined;

      if (userImageModel) {
        // User specified an image model - validate it
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
        imageModelInfo = models.find(m => m.id === userImageModel && m.type === 'image');

        if (!imageModelInfo) {
          throw new BadRequestError(
            `Image model "${userImageModel}" not available or is not an image model. Please select a valid image model.`
          );
        }

        imageModelId = userImageModel;
        imageLogger.info(`[Blog Image] Using user-selected image model: ${imageModelId}`);
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
        imageLogger.info(`[Blog Image] Using operations image model: ${imageModelId}`);
      }

      // Re-asserted here (both branches above already guarantee this): narrows the type for
      // every use below, which the if/else diamond above does not do on its own.
      if (!imageModelId || !imageModelInfo) {
        throw new BadRequestError('No image generation model available.');
      }

      // Handle prompt length limits for different models
      let cleanPrompt = imagePrompt.trim();
      if (imageModelId === ImageModels.GPT_IMAGE_1 && cleanPrompt.length > 1000) {
        const originalLength = cleanPrompt.length;
        cleanPrompt = cleanPrompt.substring(0, 980) + '...';
        imageLogger.warn(`[Blog Image] Truncated prompt for GPT-Image-1: ${originalLength} → ${cleanPrompt.length}`);
      }

      // Determine optimal parameters based on model
      const imageParams: any = {
        model: imageModelId,
        n: 1,
        user: userId,
      };

      if (imageModelId === ImageModels.GPT_IMAGE_1) {
        imageParams.size = '1024x1024';
        imageParams.quality = 'high';
      } else if (imageModelId.startsWith('flux-')) {
        imageParams.width = 1024;
        imageParams.height = 1024;
        imageParams.safety_tolerance = 4;
        imageParams.output_format = 'png';
        imageParams.prompt_upsampling = true;
      }

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

      const { aiImageService } = await import('@bike4mind/utils');

      // Choose the appropriate service based on the model backend
      const isBFLModel = imageModelId.startsWith('flux-');

      // Final validation before service creation
      if (isBFLModel && !apiKeyTable.bfl) {
        throw new BadRequestError('BFL model selected but no BFL API key available');
      }
      if (!isBFLModel && !apiKeyTable.openai) {
        throw new BadRequestError('OpenAI model selected but no OpenAI API key available');
      }

      const imageService = isBFLModel
        ? aiImageService('bfl', apiKeyTable.bfl!, req.logger)
        : aiImageService('openai', apiKeyTable.openai!, req.logger);

      const enforceCredits = await isCreditsEnforced();
      const costInput = { model: imageModelId, size: imageParams.size, quality: imageParams.quality };
      let requiredCredits: number;
      try {
        ({ requiredCredits } = estimateImageCredits(imageModelInfo, imageParams.n, costInput));
      } catch (error) {
        if (!(error instanceof UnsupportedImageModelError)) throw error;
        // Fail closed: with credits enforced, a model we cannot price is never run on the platform key.
        if (enforceCredits) {
          return res.status(400).json({
            success: false,
            imageUrl: '',
            message: `Image model "${imageModelId}" cannot be priced. Please select a different image model.`,
          });
        }
        requiredCredits = 0;
      }
      const reservation = await reserveRequestCredits({
        req,
        requiredCredits,
        enforceCredits,
        featureLabel: 'blog featured image generation',
      });

      imageLogger.info(`[Blog Image] Generating with ${imageModelId}...`);
      let generatedImages: string[];
      try {
        generatedImages = await imageService.generate(cleanPrompt, imageParams);
        if (!generatedImages || generatedImages.length === 0) {
          throw new Error('No images were generated');
        }
      } catch (error) {
        await reservation.refund();
        throw error;
      }

      const sessionId = `blog-image-${userId}-${randomUUID()}`;
      const costUsd =
        requiredCredits > 0 ? computeImageUsdCostPerImage(imageModelId, costInput) * generatedImages.length : 0;
      const creditsCharged = await reservation.settle(
        reservation.reservedCredits > 0 ? usdToCredits(costUsd) : 0,
        // No quest backs this generation; the sessionId stands in for the ledger's questId.
        { type: 'image_generation_usage', model: imageModelId, sessionId, questId: sessionId }
      );
      await usageEventRepository
        .record({
          requestId: sessionId,
          userId,
          ownerId: reservation.ownerId,
          ownerType: reservation.ownerType,
          feature: 'image_generation',
          provider: imageModelInfo.backend,
          model: imageModelId,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          units: generatedImages.length,
          costUsd,
          creditsCharged,
          status: 'ok',
        })
        .catch(err => req.logger.warn('[Blog Image] usage event failed', err));

      const providerImageUrl = generatedImages[0];
      imageLogger.info(`[Blog Image] Generated successfully: ${providerImageUrl.substring(0, 100)}...`);

      // Download the image server-side to avoid CSP issues with external domains
      // (e.g., BFL uses Azure blob storage which isn't in our CSP)
      imageLogger.info(`[Blog Image] Downloading image server-side to convert to base64...`);
      const imageResponse = await axios.get(providerImageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      const imageBuffer = Buffer.from(imageResponse.data);
      const contentType = imageResponse.headers['content-type'] || 'image/png';
      const base64Image = `data:${contentType};base64,${imageBuffer.toString('base64')}`;

      imageLogger.info(`[Blog Image] Converted to base64 (${Math.round(imageBuffer.length / 1024)}KB)`);

      res.json({
        success: true,
        imageUrl: base64Image,
      });
    } catch (error) {
      // The credit reservation keeps its own 422 rather than collapsing into the generic 500.
      if (error instanceof UnprocessableEntityError) throw error;
      imageLogger.error('[Blog Image] Error generating featured image:', error);

      let errorMessage = 'Failed to generate featured image. Please try again.';
      if (error instanceof Error) {
        if (error.message.includes('API key') || error.message.includes('model')) {
          errorMessage = 'AI service temporarily unavailable. Please try again later.';
        } else if (error.message.includes('credits')) {
          errorMessage = 'Insufficient credits to generate image.';
        } else {
          errorMessage = error.message;
        }
      }

      res.status(500).json({
        success: false,
        imageUrl: '',
        message: errorMessage,
      });
    }
  }
);

export default handler;
