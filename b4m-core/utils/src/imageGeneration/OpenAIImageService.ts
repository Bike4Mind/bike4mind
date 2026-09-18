import { AIImageService, ImageEditOptions, ImageEditResponse } from './AIImageService';
import OpenAI from 'openai';
import { ImageGenerateParams } from 'openai/resources/images';
import { Logger } from '@bike4mind/observability';
import {
  IMAGE_SIZE_CONSTRAINTS,
  ImageModels,
  isGPTImageModel,
  isGPTImage2Model,
  OPENAI_GPT_IMAGE_1_IMAGE_SIZES,
  OPENAI_GPT_IMAGE_2_IMAGE_SIZES,
  type ImageOutputFormat,
  type OpenAIImageBackground,
} from '@bike4mind/common';
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

// GPT-Image models accept these quality values on both the generate and edit endpoints -
// not the raw ImageGenerateParams/ImageEditParams `quality` union, which spans every model
// (dall-e-2/3's 'standard'/'hd' included), but the SDK's own per-model prose on that field
// ("high, medium and low are supported for the GPT image models") plus the live
// /images/edits behavior. DALL-E's legacy 'standard'/'hd' pair is mapped away by
// mapQualityForModel upstream before it reaches here.
const GPT_IMAGE_QUALITY_VALUES = ['low', 'medium', 'high', 'auto'] as const;
type GptImageQuality = (typeof GPT_IMAGE_QUALITY_VALUES)[number];

function isGptImageQuality(value: unknown): value is GptImageQuality {
  return typeof value === 'string' && (GPT_IMAGE_QUALITY_VALUES as readonly string[]).includes(value);
}

/**
 * Normalizes a requested quality to the tier a GPT-Image model actually accepts, or
 * undefined when it maps to nothing usable. The 'standard'/'hd' translation must stay
 * in step with OpenAIImageCostCalculator.normalizeInput (services) and
 * ImageGeneration's mapQualityForModel, which bill against the mapped tier - if they
 * diverge, the user is charged one tier and rendered another.
 */
export function toGptImageQuality(quality?: string | null): GptImageQuality | undefined {
  const mapped = quality === 'standard' ? 'medium' : quality === 'hd' ? 'high' : quality;
  return isGptImageQuality(mapped) ? mapped : undefined;
}

// Only appends "..." when the prompt is actually cut, so a short prompt in a log line
// doesn't misleadingly read as truncated.
const truncatePromptForLog = (prompt: string): string => (prompt.length > 100 ? `${prompt.slice(0, 100)}...` : prompt);

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

/**
 * Splits a WIDTHxHEIGHT size into its two edges, or null when the value is not a
 * pair of non-zero numbers (e.g. 'auto', '', 'wide'). Null means "not a custom
 * resolution" rather than "invalid": generate() has always left such values
 * untouched, and that behaviour is preserved.
 */
function parseSizeEdges(size?: string | null): { width: number; height: number } | null {
  if (typeof size !== 'string') {
    return null;
  }
  const [width, height] = size.split('x').map(Number);
  if (!width || !height) {
    return null;
  }
  return { width, height };
}

/**
 * True when a custom gpt-image-2 resolution meets OpenAI's documented limits.
 * gpt-image-2 accepts any resolution satisfying these, not only the presets in
 * OPENAI_GPT_IMAGE_2_IMAGE_SIZES, so a flat preset check would reject valid
 * custom sizes. Must stay the single source of this rule for generate() and edit().
 */
function satisfiesGptImage2Constraints({ width, height }: { width: number; height: number }): boolean {
  const { maxEdge, minTotalPixels, maxTotalPixels, edgeMultiple, maxAspectRatio } =
    IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.constraints;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const totalPixels = width * height;

  return (
    longEdge <= maxEdge &&
    width % edgeMultiple === 0 &&
    height % edgeMultiple === 0 &&
    longEdge / shortEdge <= maxAspectRatio &&
    totalPixels >= minTotalPixels &&
    totalPixels <= maxTotalPixels
  );
}

/**
 * True when `size` may be forwarded to images.edit for `model`. gpt-image-2 takes
 * its presets (including 'auto') or any custom WIDTHxHEIGHT meeting the same
 * constraints generate() enforces; the gpt-image-1 family is limited to its three
 * fixed sizes. An unsupported size is dropped by the caller so OpenAI applies its
 * own default instead of rejecting the whole request with a 400.
 *
 * GPT-Image tiers only: dall-e-2 has its own size list and passes size through
 * untouched, so do not route that model here.
 */
export function isSupportedEditSize(model?: string | null, size?: string | null): boolean {
  if (typeof size !== 'string') {
    return false;
  }

  if (isGPTImage2Model(model)) {
    if ((OPENAI_GPT_IMAGE_2_IMAGE_SIZES as readonly string[]).includes(size)) {
      return true;
    }
    const edges = parseSizeEdges(size);
    return edges !== null && satisfiesGptImage2Constraints(edges);
  }

  return (OPENAI_GPT_IMAGE_1_IMAGE_SIZES as readonly string[]).includes(size);
}

export type OpenAIImageGenerationOptions = Omit<ImageGenerateParams, 'prompt'> & {
  safety_tolerance?: number;
  prompt_upsampling?: boolean;
  seed?: number | null;
  output_format?: ImageOutputFormat | null;
  imagePrompt?: string;
};

/**
 * Resolve the alpha/container pair gpt-image accepts. OpenAI rejects
 * `background: 'transparent'` together with jpeg (no alpha channel), so a transparent
 * request promotes the container to png rather than failing the whole render.
 * gpt-image-2 rejects `background: 'transparent'` outright, so it is dropped there
 * (falling back to OpenAI's own default) with a warning instead of 400-ing the whole
 * request - this is the single backstop for every call site (generate/edit, tool call
 * or queue handler, explicit model selection or default), so `model` must be the
 * fully-resolved model actually sent to OpenAI, not a pre-fallback value.
 * Returns the fields to spread onto the request; absent keys mean "let OpenAI default".
 */
export function resolveGptImageOutputOptions(
  background: OpenAIImageBackground | null | undefined,
  outputFormat: ImageOutputFormat | null | undefined,
  warnings: string[],
  model?: string | null
): { background?: OpenAIImageBackground; output_format?: ImageOutputFormat } {
  const resolved: { background?: OpenAIImageBackground; output_format?: ImageOutputFormat } = {};
  if (background) {
    resolved.background = background;
  }
  if (outputFormat) {
    resolved.output_format = outputFormat;
  }
  if (background === 'transparent' && isGPTImage2Model(model)) {
    delete resolved.background;
    warnings.push("gpt-image-2 does not support background: 'transparent'; background parameter removed");
  }
  if (resolved.background === 'transparent' && outputFormat === 'jpeg') {
    resolved.output_format = 'png';
    warnings.push(
      "Transparent background requires an alpha-capable format; output_format changed from 'jpeg' to 'png'"
    );
  }
  return resolved;
}

export class OpenAIImageService extends AIImageService {
  async generate(prompt: string, options: OpenAIImageGenerationOptions): Promise<string[]> {
    const openai = new OpenAI({ apiKey: this.apiKey, ...OPENAI_IMAGE_CLIENT_OPTS });
    Logger.log('Generating image... with these params: ', options);

    try {
      // Remove BFL-specific parameters since OpenAI doesn't use them. `background` and
      // `output_format` are pulled out here and re-applied only on the gpt-image branch,
      // which is the only family that accepts them.
      const {
        safety_tolerance,
        prompt_upsampling,
        seed: bflSeed,
        output_format,
        background,
        imagePrompt,
        stream,
        ...openaiOptions
      } = options;

      const parameterWarnings: string[] = [];
      let gptImageOutputOptions: ReturnType<typeof resolveGptImageOutputOptions> = {};
      // Declared here (not inside the if-block below) so the debug-log flush after the
      // if/else can report it for both branches.
      const modelName = options.model || ImageModels.GPT_IMAGE_1_5;

      // GPT-Image specific parameter validation and graceful fallback
      if (isGPTImageModel(options.model)) {
        openaiOptions.model = modelName;

        gptImageOutputOptions = resolveGptImageOutputOptions(background, output_format, parameterWarnings, modelName);

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

        // GPT-Image models bill by quality tier (see validateUserCredits upstream), so an
        // accepted value must actually reach OpenAI - only an unmappable value is dropped.
        if (openaiOptions.quality) {
          const mappedQuality = toGptImageQuality(openaiOptions.quality);
          if (mappedQuality) {
            openaiOptions.quality = mappedQuality;
          } else {
            parameterWarnings.push(
              `Quality parameter ('${openaiOptions.quality}') is not supported by ${modelName} and was removed`
            );
            delete openaiOptions.quality;
          }
        }

        if (isGPTImage2Model(options.model)) {
          // gpt-image-2 supports flexible sizes - validate constraints instead of fixed list
          if (openaiOptions.size && openaiOptions.size !== 'auto') {
            const edges = parseSizeEdges(openaiOptions.size);
            if (edges && !satisfiesGptImage2Constraints(edges)) {
              const originalSize = openaiOptions.size;
              openaiOptions.size = '1024x1024';
              parameterWarnings.push(`Size '${originalSize}' violates gpt-image-2 constraints, changed to '1024x1024'`);
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
      } else {
        // For other OpenAI models (legacy support)
        openaiOptions.response_format = 'url';

        if (background) {
          parameterWarnings.push(
            `Background parameter ('${background}') is only supported by gpt-image models and was removed`
          );
        }

        if (output_format) {
          parameterWarnings.push(
            `Output format parameter ('${output_format}') is only supported by gpt-image models and was removed`
          );
        }

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

      if (parameterWarnings.length > 0) {
        Logger.globalInstance.debug(`[DEBUG] ⚠️ ${modelName} parameter adjustments:`, parameterWarnings);
        // These warnings could be sent to the client via WebSocket for user notification
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

          // quality/size are already validated for this model above (same block that
          // handles the text-to-image branch); forward them, plus n, because generate()'s
          // credit reservation is per requested image at the requested tier (validateUserCredits
          // charges usdCost * n) - dropping any of the three bills for output OpenAI is
          // never asked to produce. (edit() below has its own, narrower n handling - see its
          // own comment - this invariant does not extend to that method.) The background/output_format
          // alpha controls are resolved above alongside the other gpt-image parameter validation.
          const editQuality = toGptImageQuality(openaiOptions.quality);
          const editSize = isSupportedEditSize(editModel, openaiOptions.size) ? openaiOptions.size : undefined;

          this.logger.log('OpenAI image generation request (edit endpoint, image-to-image):', {
            model: editModel,
            prompt: truncatePromptForLog(prompt),
            quality: editQuality,
            size: editSize,
            n: openaiOptions.n,
            ...gptImageOutputOptions,
          });
          result = await openai.images.edit({
            model: editModel as 'gpt-image-1' | 'gpt-image-1.5' | 'gpt-image-1-mini' | 'gpt-image-2',
            image: [imageFile],
            prompt,
            ...(editQuality ? { quality: editQuality } : {}),
            ...(editSize ? { size: editSize } : {}),
            ...(openaiOptions.n ? { n: openaiOptions.n } : {}),
            ...gptImageOutputOptions,
          });
        } else {
          // Legacy models (DALL-E 2) use the variation endpoint

          const { style, quality, model, ...opts } = openaiOptions; // Remove unsupported params for variations
          const variationSize = ['256x256', '512x512', '1024x1024'].find(s => s === openaiOptions.size) as
            '256x256' | '512x512' | '1024x1024';

          this.logger.log('OpenAI image generation request (variation endpoint):', { ...opts, size: variationSize });
          result = await openai.images.createVariation({
            ...opts,
            image: imageFile,
            size: variationSize,
          });
        }
      } else {
        this.logger.log('OpenAI image generation request:', { prompt: truncatePromptForLog(prompt), ...openaiOptions });
        result = await openai.images.generate({
          prompt,
          ...openaiOptions,
          ...gptImageOutputOptions,
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
    // The container is only reported on the envelope, so read it here rather than
    // labelling every base64 payload image/png - a webp or jpeg render would otherwise
    // reach storage with a data URL that contradicts its own bytes.
    const mimeType = `image/${response?.output_format ?? 'png'}`;
    return (response?.data ?? []).map(imageData => {
      // GPT-Image-1 returns b64_json instead of url
      if (imageData.b64_json) {
        // Convert base64 to data URL for processing
        return `data:${mimeType};base64,${imageData.b64_json}`;
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
    {
      mask = null,
      model = ImageModels.GPT_IMAGE_2,
      n = 1,
      quality,
      size,
      response_format = 'url',
      user,
      background,
      output_format,
    }: ImageEditOptions
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

      const editWarnings: string[] = [];
      const gptImageOutputOptions = resolveGptImageOutputOptions(background, output_format, editWarnings, editModel);
      if (editWarnings.length > 0) {
        Logger.globalInstance.debug(`[DEBUG] ⚠️ ${editModel} parameter adjustments:`, editWarnings);
      }

      // GPT-Image models (1, 1.5, 1-mini, 2) also accept `size` and `mask`, but only a size
      // their own tier supports - a dall-e-2 size (e.g. 256x256/512x512) or an out-of-range
      // resolution is a 400 from OpenAI. gpt-image-2 also takes any custom WIDTHxHEIGHT
      // meeting its constraints, so this must not be a flat preset check. An unsupported or
      // absent size is omitted so OpenAI's own default sizing applies, as it did before.
      // The background/output_format alpha controls are resolved above via gptImageOutputOptions.
      // dall-e-2 supports: model, image (single), prompt, mask, n, size, response_format, user
      const forwardSize = isSupportedEditSize(editModel, size);
      // Callers bill against the requested tier before getting here, so it has to reach
      // OpenAI; an unmappable value is dropped rather than 400-ing the whole request.
      const editQuality = toGptImageQuality(quality);

      this.logger.log('OpenAI image edit request:', {
        model: editModel,
        prompt: truncatePromptForLog(prompt),
        hasMask: !!maskFile,
        // What the caller asked for, not what renders: this path always returns one image.
        requestedN: n,
        size,
        quality: editQuality,
        response_format,
      });

      const response = await openai.images.edit(
        isGPTImageModel(editModel)
          ? {
              model: editModel as 'gpt-image-1' | 'gpt-image-1.5' | 'gpt-image-1-mini' | 'gpt-image-2',
              image: [imageFile],
              prompt,
              ...(forwardSize ? { size } : {}),
              ...(maskFile ? { mask: maskFile } : {}),
              ...(editQuality ? { quality: editQuality } : {}),
              ...gptImageOutputOptions,
            }
          : {
              model: editModel as 'dall-e-2',
              image: imageFile,
              prompt,
              mask: maskFile,
              // Pinned, not forwarded from `n`: only data[0] is returned below, so asking
              // OpenAI for more renders images we pay for and then discard.
              n: 1,
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
        const dataUrl = result.b64_json
          ? `data:image/${response.output_format ?? 'png'};base64,${result.b64_json}`
          : result.url;

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
