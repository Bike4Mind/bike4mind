import { AIImageService, ImageEditOptions, ImageEditResponse } from './AIImageService';
import OpenAI from 'openai';
import { ImageGenerateParams } from 'openai/resources/images';
import { Logger } from '@bike4mind/observability';
import { ImageModels, isGPTImageModel, isGPTImage2Model } from '@bike4mind/common';
import { invokeImageProcessor, downloadImageAsBuffer } from './imageProcessorUtils';

// The image-generation Lambda has a 10-minute timeout. The OpenAI SDK's default
// request timeout is also 10 minutes, so a hung/slow request (e.g. gpt-image-2
// reasoning renders) expires at the same moment the Lambda is hard-killed - the
// SDK's timeout error never fires and the handler's catch never writes a failure
// back to the quest, leaving the user on an eternal spinner. Capping the
// client well under the Lambda budget guarantees a catchable timeout, and
// maxRetries: 0 keeps total time bounded under that budget.
const OPENAI_IMAGE_CLIENT_OPTS = { timeout: 8 * 60 * 1000, maxRetries: 0 } as const;

// Alternative image models with different content policies, surfaced to users
// whose prompt is blocked by OpenAI's safety system. Flux Pro in
// particular handles a broader range of prompts than gpt-image-*.
const ALTERNATIVE_IMAGE_MODELS = 'Flux Pro, Flux Dev, or Grok';

/**
 * Builds a user-friendly error when OpenAI's safety system blocks an image
 * request, guiding the user to rephrase or switch to an alternative model.
 * Returns null when the error is not a content-policy / moderation block, so
 * callers can fall through to generic error handling.
 *
 * A plain `status === 400` is treated as a likely moderation block only
 * when no more specific OpenAI `code` is present - genuine parameter errors
 * (which carry a `code`/`param`) should not masquerade as content-policy blocks.
 * The known content-policy codes are matched explicitly: gpt-image-* uses
 * `moderation_blocked`, while DALL-E 3 (generation-only) uses
 * `content_policy_violation`.
 */
const CONTENT_POLICY_ERROR_CODES = ['moderation_blocked', 'content_policy_violation'];

export function buildModerationBlockedError(error: InstanceType<typeof OpenAI.APIError>): Error | null {
  const isModerationBlocked = typeof error.code === 'string' && CONTENT_POLICY_ERROR_CODES.includes(error.code);
  const isUnspecified400 = error.status === 400 && !error.code;
  if (!isModerationBlocked && !isUnspecified400) {
    return null;
  }

  const requestId = (error as { requestID?: string }).requestID || 'unknown';
  return new Error(
    `⚠️ Your image request was blocked by OpenAI's content policy. This can happen for various reasons:\n\n` +
      `1. The prompt may contain terms that trigger safety filters\n` +
      `2. Try rephrasing your prompt with more neutral language\n` +
      `3. Avoid potentially sensitive topics or explicit content\n\n` +
      `Tip: Switch to an alternative model with different content policies — e.g. ${ALTERNATIVE_IMAGE_MODELS} — which may accept this prompt.\n\n` +
      `If you believe this is an error, you can report it to OpenAI with request ID: ${requestId}`
  );
}

export type OpenAIImageGenerationOptions = Omit<ImageGenerateParams, 'prompt'> & {
  safety_tolerance?: number;
  prompt_upsampling?: boolean;
  seed?: number | null;
  output_format?: 'jpeg' | 'png' | null;
  imagePrompt?: string;
};

export class OpenAIImageService extends AIImageService {
  async generate(prompt: string, options: OpenAIImageGenerationOptions): Promise<string[]> {
    const openai = new OpenAI({ apiKey: this.apiKey, ...OPENAI_IMAGE_CLIENT_OPTS });
    Logger.log('Generating image... with these params: ', options);

    try {
      // Remove BFL-specific parameters since OpenAI doesn't use them
      const {
        safety_tolerance,
        prompt_upsampling,
        seed: bflSeed,
        output_format,
        imagePrompt,
        stream,
        ...openaiOptions
      } = options;

      const parameterWarnings: string[] = [];

      // GPT-Image specific parameter validation and graceful fallback
      if (isGPTImageModel(options.model)) {
        const modelName = options.model || ImageModels.GPT_IMAGE_1_5;

        openaiOptions.model = modelName;

        // Remove unsupported parameters with warnings
        if (openaiOptions.style) {
          parameterWarnings.push(
            `Style parameter ('${openaiOptions.style}') is not supported by ${modelName} and was removed`
          );
          delete openaiOptions.style;
        }

        if (openaiOptions.response_format) {
          delete openaiOptions.response_format;
        }

        // GPT-Image models don't support quality parameter for text-to-image generation
        if (openaiOptions.quality) {
          parameterWarnings.push(
            `Quality parameter ('${openaiOptions.quality}') is not supported by ${modelName} text-to-image generation and was removed`
          );
          delete openaiOptions.quality;
        }

        if (isGPTImage2Model(options.model)) {
          // gpt-image-2 supports flexible sizes - validate constraints instead of fixed list
          if (openaiOptions.size && openaiOptions.size !== 'auto') {
            const [w, h] = openaiOptions.size.split('x').map(Number);
            if (w && h) {
              const maxEdge = Math.max(w, h);
              const minEdge = Math.min(w, h);
              const totalPixels = w * h;
              if (
                maxEdge > 3840 ||
                w % 16 !== 0 ||
                h % 16 !== 0 ||
                maxEdge / minEdge > 3 ||
                totalPixels < 655_360 ||
                totalPixels > 8_294_400
              ) {
                const originalSize = openaiOptions.size;
                openaiOptions.size = '1024x1024';
                parameterWarnings.push(
                  `Size '${originalSize}' violates gpt-image-2 constraints, changed to '1024x1024'`
                );
              }
            }
          } else if (!openaiOptions.size) {
            // gpt-image-2 defaults to 'auto' if no size provided
            openaiOptions.size = 'auto';
          }
        } else {
          const validGPTSizes = ['1024x1024', '1536x1024', '1024x1536'];
          if (openaiOptions.size) {
            if (!validGPTSizes.includes(openaiOptions.size)) {
              const originalSize = openaiOptions.size;
              openaiOptions.size = '1024x1024';
              parameterWarnings.push(`Size '${originalSize}' is not supported by ${modelName}, changed to '1024x1024'`);
            }
          } else {
            openaiOptions.size = '1024x1024';
          }
        }

        // Remove any custom dimensions (width/height) as GPT-Image models use fixed sizes
        if ('width' in openaiOptions || 'height' in openaiOptions) {
          const dims = openaiOptions as { width?: unknown; height?: unknown };
          delete dims.width;
          delete dims.height;
          parameterWarnings.push(`Custom width/height not supported by ${modelName}, using standard sizes`);
        }

        if (parameterWarnings.length > 0) {
          Logger.globalInstance.debug(`[DEBUG] ⚠️ ${modelName} parameter adjustments:`, parameterWarnings);
          // These warnings could be sent to the client via WebSocket for user notification
        }
      } else {
        // For other OpenAI models (legacy support)
        openaiOptions.response_format = 'url';

        if (openaiOptions.quality && !['standard', 'hd'].includes(openaiOptions.quality)) {
          const originalQuality = openaiOptions.quality;
          openaiOptions.quality = 'standard';
          parameterWarnings.push(
            `Quality '${originalQuality}' is not supported by legacy models, changed to 'standard'`
          );
        }

        const validLegacySizes = ['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792'];
        if (openaiOptions.size && !validLegacySizes.includes(openaiOptions.size)) {
          const originalSize = openaiOptions.size;
          openaiOptions.size = '1024x1024';
          parameterWarnings.push(`Size '${originalSize}' is not supported by legacy models, changed to '1024x1024'`);
        }
      }

      // Map seed parameter if provided (OpenAI uses 'seed' directly)
      if (bflSeed !== null && bflSeed !== undefined) {
        (openaiOptions as { seed?: number }).seed = bflSeed;
      }

      let images: string[] = [];
      let result;

      if (imagePrompt) {
        // Download the image; invokeImageProcessor converts it to PNG and enforces
        // OpenAI's size limit.
        const imageBuffer = await downloadImageAsBuffer(imagePrompt);
        if (!this.imageProcessorLambdaName) {
          throw new Error(
            'ImageProcessor Lambda name is required for image processing. Please provide it when creating the image service.'
          );
        }
        const pngBuffer = await invokeImageProcessor(imageBuffer, this.imageProcessorLambdaName, 4); // 4MB max for OpenAI

        const imageFile = new File([pngBuffer], 'image.png', { type: 'image/png' });

        // GPT-Image models use the edit endpoint for image-to-image generation
        if (isGPTImageModel(options.model)) {
          // IMPORTANT: Edit endpoint supports gpt-image-1, gpt-image-1.5, gpt-image-1-mini, and dall-e-2
          // NOTE: DALL-E 3 does NOT support image editing at all
          const editModel = options.model || ImageModels.GPT_IMAGE_2;

          // IMPORTANT: GPT-Image models edit endpoint only supports: model, image (array), prompt
          // Do not pass any other parameters (size, response_format, etc.)
          result = await openai.images.edit({
            model: editModel as 'gpt-image-1' | 'gpt-image-1.5' | 'gpt-image-1-mini' | 'gpt-image-2',
            image: [imageFile],
            prompt,
          });
        } else {
          // Legacy models (DALL-E 2) use the variation endpoint

          const { style, quality, model, ...opts } = openaiOptions; // Remove unsupported params for variations

          result = await openai.images.createVariation({
            ...opts,
            image: imageFile,
            size: ['256x256', '512x512', '1024x1024'].find(s => s === openaiOptions.size) as
              '256x256' | '512x512' | '1024x1024',
          });
        }
      } else {
        result = await openai.images.generate({
          prompt,
          ...openaiOptions,
        });
      }

      images = this.imageResponseToUrl(result);

      return images;
    } catch (error) {
      Logger.globalInstance.error('[DEBUG] Error in OpenAI image generation:', {
        model: options.model,
        error: error,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      });

      if (error instanceof OpenAI.APIError) {
        Logger.globalInstance.error('[DEBUG] OpenAI API error details:', {
          status: error.status,
          message: error.message,
          code: error.code,
          type: error.type,
          param: error.param,
        });

        // Handle moderation errors with user-friendly message
        const moderationError = buildModerationBlockedError(error);
        if (moderationError) {
          throw moderationError;
        }

        // Surface billing/auth/rate-limit failures with an actionable message instead of the raw
        // "Request failed with status code 402" the SDK throws. GPT Image models in particular
        // require the OpenAI organization to be verified and to have active billing/quota.
        if (error.status === 402) {
          throw new Error(
            `OpenAI image generation requires payment or verification (402). Ensure the OpenAI account has active billing/quota and that the organization is verified for GPT Image models, or pick a different image model (e.g. Flux Pro).`
          );
        }
        if (error.status === 401 || error.status === 403) {
          throw new Error(
            `OpenAI API access denied (${error.status}). The OpenAI API key may be missing, invalid, or lack access to this image model.`
          );
        }
        if (error.status === 429) {
          throw new Error(`OpenAI API rate limit exceeded (429). Please wait a moment and try again.`);
        }
      }

      throw error instanceof Error ? error : new Error('OpenAI image generation error: Unknown error');
    }
  }

  private imageResponseToUrl(response: OpenAI.Images.ImagesResponse): string[] {
    return (response?.data ?? []).map(imageData => {
      // GPT-Image-1 returns b64_json instead of url
      if (imageData.b64_json) {
        // Convert base64 to data URL for processing
        return `data:image/png;base64,${imageData.b64_json}`;
      }

      // GPT-Image-1 and other OpenAI models return url
      if (imageData.url) {
        return imageData.url;
      }

      throw new Error(`Image response contains neither url nor b64_json: ${JSON.stringify(Object.keys(imageData))}`);
    });
  }

  async edit(
    image: string,
    prompt: string,
    { mask = null, model = ImageModels.GPT_IMAGE_2, n = 1, size, response_format = 'url', user }: ImageEditOptions
  ): Promise<ImageEditResponse> {
    try {
      const openai = new OpenAI({ apiKey: this.apiKey, ...OPENAI_IMAGE_CLIENT_OPTS });

      // Convert base64 image strings to File objects
      const cleanImageBase64 = image.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
      const imageBuffer = Buffer.from(cleanImageBase64, 'base64');
      // Ensure image is PNG and under size limit using serverless image processor
      if (!this.imageProcessorLambdaName) {
        throw new Error(
          'ImageProcessor Lambda name is required for image processing. Please provide it when creating the image service.'
        );
      }
      const pngBuffer = await invokeImageProcessor(imageBuffer, this.imageProcessorLambdaName, 4);
      const imageFile = new File([pngBuffer], 'image.png', { type: 'image/png' });

      let maskFile: File | undefined;
      if (mask) {
        const cleanMaskBase64 = mask.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
        const maskBuffer = Buffer.from(cleanMaskBase64, 'base64');
        // Ensure mask is PNG and under size limit using serverless image processor
        if (!this.imageProcessorLambdaName) {
          throw new Error(
            'ImageProcessor Lambda name is required for image processing. Please provide it when creating the image service.'
          );
        }
        const pngMaskBuffer = await invokeImageProcessor(maskBuffer, this.imageProcessorLambdaName, 4);
        maskFile = new File([pngMaskBuffer], 'mask.png', { type: 'image/png' });
      }

      // IMPORTANT: The edit endpoint supports gpt-image-1, gpt-image-1.5, gpt-image-1-mini, and dall-e-2
      // NOTE: DALL-E 3 does NOT support image editing at all. Use GPT-Image models for editing.
      // @see https://platform.openai.com/docs/guides/image-generation#edit-images
      let editModel = model;
      if (!isGPTImageModel(model) && model !== ImageModels.DALL_E_2) {
        Logger.globalInstance.debug(`[DEBUG] ⚠️ Edit endpoint doesn't support ${model}, defaulting to gpt-image-2`);
        editModel = ImageModels.GPT_IMAGE_2;
      }

      // IMPORTANT: GPT-Image models (1, 1.5, 1-mini) only support: model, image (array), prompt
      // dall-e-2 supports: model, image (single), prompt, mask, n, size, response_format, user
      const response = await openai.images.edit(
        isGPTImageModel(editModel)
          ? {
              model: editModel as 'gpt-image-1' | 'gpt-image-1.5' | 'gpt-image-1-mini' | 'gpt-image-2',
              image: [imageFile],
              prompt,
            }
          : {
              model: editModel as 'dall-e-2',
              image: imageFile,
              prompt,
              mask: maskFile,
              n,
              size: size as '1024x1024' | '1024x1536' | '1536x1024' | '256x256' | '512x512' | 'auto' | undefined,
              response_format,
              user,
            }
      );

      // Return the first image URL or base64
      if (response.data && response.data.length > 0) {
        const result = response.data[0];
        // Check what the response actually contains, not what we requested
        // gpt-image-1 returns b64_json by default, dall-e-2 returns based on response_format
        const dataUrl = result.b64_json ? `data:image/png;base64,${result.b64_json}` : result.url;

        if (!dataUrl) {
          throw new Error(`Image response contains neither url nor b64_json: ${JSON.stringify(Object.keys(result))}`);
        }

        return { type: 'success' as const, dataUrl };
      }

      throw new Error('No image was generated');
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        Logger.globalInstance.error('[DEBUG] OpenAI API error details:', {
          status: error.status,
          message: error.message,
          code: error.code,
        });

        // Handle moderation errors with the same user-friendly guidance as generate()
        const moderationError = buildModerationBlockedError(error);
        if (moderationError) {
          throw moderationError;
        }
      }
      throw error instanceof Error ? error : new Error('OpenAI image edit error: Unknown error');
    }
  }
}
