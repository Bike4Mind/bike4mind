import { Logger } from '@bike4mind/observability';
import { ToolContext, ToolDefinition } from '../../base/types';
import {
  ApiKeyType,
  ImageModels,
  BFL_SAFETY_TOLERANCE,
  GEMINI_IMAGE_MODELS,
  GenerateImageToolCall,
  isImageServeable,
  isBflImageModel,
  isGeminiImageModel,
} from '@bike4mind/common';
import {
  OpenAIImageService,
  BFLImageService,
  GeminiImageService,
  getSettingsMap,
  getSettingsValue,
} from '@bike4mind/utils';
import { RekognitionImageModerationService } from '@bike4mind/utils/imageModeration';
import { getEffectiveApiKey } from '../../../../apiKeyService';
import axios from 'axios';
import { fileTypeFromBuffer } from 'file-type';
import { v4 as uuidv4 } from 'uuid';
import { NotFoundError } from '@bike4mind/utils';
import { moderateImageOrThrow } from '../../../imageModerationGate';

// Models that support image editing.
// All Gemini image models support editing, so derive that portion from
// GEMINI_IMAGE_MODELS to avoid drift as new Gemini models are added.
const EDIT_SUPPORTED_MODELS = [
  ImageModels.GPT_IMAGE_1,
  ImageModels.GPT_IMAGE_1_5,
  ImageModels.GPT_IMAGE_1_MINI,
  ImageModels.GPT_IMAGE_2,
  ImageModels.FLUX_PRO_FILL,
  ...GEMINI_IMAGE_MODELS,
];

async function downloadImage(url: string) {
  // Handle data URLs (base64 images)
  if (url.startsWith('data:image/')) {
    const base64Data = url.split(',')[1];
    return Buffer.from(base64Data, 'base64');
  }

  // Handle regular URLs
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    return response.data;
  } catch (error) {
    // If URL fails (expired, inaccessible, etc.), throw a more helpful error
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 403 || error.response?.status === 404) {
        throw new Error(
          `Image URL is expired or inaccessible. Please use a file ID from the workbench or a recently generated image URL. Original error: ${error.message}`
        );
      }
      throw new Error(`Failed to download image from URL: ${error.message}`);
    }
    throw error;
  }
}

async function imageUrlToBase64(imageUrl: string): Promise<string> {
  const data = await downloadImage(imageUrl);
  const buffer = Buffer.from(data, 'binary');
  return buffer.toString('base64');
}

// Exported for testability (mirrors `processAndStoreImage` below) - the serveability
// guard below is otherwise only reachable through the full `edit_image` toolFn, which
// requires mocking an entire provider edit call.
export async function getImageFromFileId(fileId: string, context: ToolContext): Promise<string> {
  // Validate that fileId is a valid MongoDB ObjectId (24-char hex string) before querying
  if (!/^[0-9a-fA-F]{24}$/.test(fileId)) {
    throw new Error(
      `Invalid file ID "${fileId}". Expected a MongoDB ObjectId (24-character hex string), not a filename. Please provide the file ID from the workbench, or use a full URL (https://...) to reference the image.`
    );
  }

  const fabFile = await context.db.fabfiles?.findById(fileId);
  if (!fabFile) {
    throw new NotFoundError(`File with ID ${fileId} not found`);
  }

  if (!fabFile.mimeType?.startsWith('image/')) {
    throw new Error(`File ${fileId} is not an image`);
  }

  // Refuse to hand out a held/blocked image's URL to the edit_image tool.
  if (!isImageServeable(fabFile)) {
    throw new Error('This image is not available.');
  }

  // Get signed URL if filePath exists, otherwise use fileUrl
  if (fabFile.filePath) {
    const signedUrl = await context.storage.getSignedUrl(fabFile.filePath);
    return signedUrl;
  }

  if (fabFile.fileUrl) {
    return fabFile.fileUrl;
  }

  throw new Error(`File ${fileId} has no accessible URL`);
}

/**
 * Resolve a generated-image storage key (the bare key persisted in
 * `quest.images`, e.g. "86cdc650-....jpg") to a downloadable URL.
 *
 * image_generation / edit_image upload their output to `imageGenerateStorage`
 * and persist only the bare key - no fabFile record is created - so a generated
 * image is NOT addressable as a fabFile ObjectId. Resolving it against the image
 * bucket is what lets a follow-up edit ("make it cartoonish") target a
 * previously generated image. The model learns these keys from the "Recently
 * generated images" system note assembled in ChatCompletionProcess.
 */
async function getGeneratedImageUrl(storageKey: string, context: ToolContext): Promise<string> {
  try {
    return await context.imageGenerateStorage.getSignedUrl(storageKey);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not resolve generated image "${storageKey}". Use the exact id from the "Recently generated images" system note, a fabFile ID from "Available Files", or a full URL. (${detail})`
    );
  }
}

/**
 * Resolve an image input (source or mask) to a downloadable URL. Accepts, in
 * priority order:
 *   - an http(s)/data URL - passed straight through
 *   - a fabFile ObjectId (24-char hex) - an uploaded image from "Available Files"
 *   - otherwise a generated-image storage key (the bare key in quest.images,
 *     e.g. "86cdc650-....jpg") - resolved against the image bucket
 * Source and mask share this so a generated-image key works for either.
 */
async function resolveImageInputUrl(input: string, context: ToolContext): Promise<string> {
  if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('data:')) {
    return input;
  }
  if (/^[0-9a-fA-F]{24}$/.test(input)) {
    return getImageFromFileId(input, context);
  }
  return getGeneratedImageUrl(input, context);
}

/**
 * The agent-tool edit_image path bypassed the moderation gate that
 * ImageEdit.process() (queue handler) already runs before upload. This wrapper closes that
 * hole for the tool path using the SAME shared gate (`moderateImageOrThrow`).
 *
 * `RekognitionImageModerationService` is constructed INLINE here (not injected via
 * ToolContext) so no app-side ToolContext builder can omit the DI and silently reopen the
 * hole - the block is unconditional for every caller of this tool, regardless of wiring.
 */
async function moderateToolImage(
  context: ToolContext,
  buffer: Buffer,
  mimeType: string,
  model: string,
  provider: string
): Promise<void> {
  const settings = await getSettingsMap(context.db);
  await moderateImageOrThrow({
    service: new RekognitionImageModerationService(context.logger),
    // `?? true`: fail toward moderation-ON, mirroring the queue-handler call sites
    // (ImageGeneration.ts / ImageEdit.ts) - for a legal-safety control the safe default is enabled.
    enabled: getSettingsValue('ImageModerationEnabled', settings) ?? true,
    incidents: context.db.imageModerationIncidents,
    buffer,
    mimeType,
    incidentMeta: {
      userId: context.userId,
      sessionId: context.sessionId,
      provider,
      model,
    },
    logger: context.logger,
  });
}

export async function processAndStoreImage(
  imageUrl: string,
  context: ToolContext,
  model: string,
  provider: string
): Promise<string> {
  const buffer = await downloadImage(imageUrl);
  const fileType = await fileTypeFromBuffer(buffer);
  const filename = `${uuidv4()}.${fileType?.ext}`;
  const mimeType = fileType?.mime ?? 'image/png';

  // Block moderated content BEFORE upload - see moderateToolImage doc comment.
  await moderateToolImage(context, buffer, mimeType, model, provider);

  const path = await context.imageGenerateStorage.upload(buffer, filename, {});

  return path;
}

/**
 * Generate a full-coverage white mask for an image using sharp.
 * This creates a mask where all areas are marked for editing (all white pixels).
 * Works in Lambda/serverless environments unlike canvas which requires native compilation.
 *
 * Uses dynamic import to avoid bundling sharp into Lambda functions that don't need it.
 *
 * @param imageBuffer - The source image buffer to match dimensions
 * @returns Base64 encoded PNG mask image (all white)
 */
async function generateFullMask(imageBuffer: Buffer): Promise<string> {
  // Dynamic import to avoid bundling sharp into all Lambda functions
  const sharp = (await import('sharp')).default;

  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width!;
  const height = metadata.height!;

  // Create a white mask (all 255 values = full white = edit entire image)
  // RGBA format: [R, G, B, A] where 255 = white/opaque
  const maskData = Buffer.alloc(width * height * 4);
  for (let i = 0; i < maskData.length; i++) {
    maskData[i] = 255; // Fill with white
  }

  const maskBuffer = await sharp(maskData, {
    raw: {
      width,
      height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();

  return maskBuffer.toString('base64');
}

async function updateQuestAndReturnMarkdown(storedImagePath: string, context: ToolContext): Promise<string> {
  // Call onFinish callback for credit deduction
  await context.onFinish?.('edit_image', storedImagePath);

  // Update the quest's images array
  await context.statusUpdate({ images: [storedImagePath] });
  return 'Successfully edited image';
}

export const imageEditTool: ToolDefinition = {
  name: 'edit_image',
  implementation: (context, config: GenerateImageToolCall) => ({
    toolFn: async val => {
      // Get imageConfig from config (shared with image_generation tool)
      const imageConfig = config;

      const {
        image: toolImage,
        prompt,
        mask: toolMask,
        n: toolN,
        size: toolSize,
        safety_tolerance: toolSafetyTolerance,
        steps: toolSteps,
        guidance: toolGuidance,
      } = val as {
        image: string; // URL or file ID
        prompt: string;
        mask?: string; // Optional URL or file ID
        n?: number;
        size?: string;
        safety_tolerance?: number;
        steps?: number; // BFL-specific, not in imageConfig
        guidance?: number; // BFL-specific, not in imageConfig
      };

      if (!toolImage) {
        return 'Error: Image is required for editing';
      }

      if (!prompt) {
        return 'Error: Prompt is required for editing';
      }

      // Use imageConfig settings as defaults, allow tool call to override
      // IMPORTANT: The edit endpoint supports gpt-image-1, gpt-image-1.5, gpt-image-1-mini, and dall-e-2
      // NOTE: DALL-E 3 does NOT support image editing at all. Use GPT-Image models for editing.
      // @see https://platform.openai.com/docs/guides/image-generation#edit-images

      // Determine edit model from imageConfig, with smart fallbacks
      const generationModel = imageConfig?.model || ImageModels.GPT_IMAGE_1_5;
      let editModel = imageConfig?.editModel as ImageModels | undefined;

      if (!editModel) {
        // Fallback logic based on generation model provider
        const isGenBFLModel = isBflImageModel(generationModel);
        const isGenGeminiModel = isGeminiImageModel(generationModel);

        if (isGenBFLModel) {
          editModel = ImageModels.FLUX_PRO_FILL; // BFL requires FLUX_PRO_FILL for mask editing
        } else if (isGenGeminiModel) {
          editModel = generationModel as ImageModels; // Gemini models support editing directly
        } else {
          // OpenAI or fallback
          editModel = ImageModels.GPT_IMAGE_1_5; // Default OpenAI edit model (no mask required)
        }
        Logger.globalInstance.debug(
          `[DEBUG] No edit model specified, using fallback: ${editModel} (based on generation model: ${generationModel})`
        );
      }

      // Validate that the edit model supports editing
      if (!(EDIT_SUPPORTED_MODELS as readonly string[]).includes(editModel)) {
        return `Error: Model ${editModel} does not support image editing. Supported models for editing: ${EDIT_SUPPORTED_MODELS.join(', ')}.

Please select a supported edit model in your image settings modal.`;
      }

      const model = generationModel; // Keep for backwards compatibility
      const n = toolN ?? imageConfig?.n ?? 1;
      const size = imageConfig?.size || toolSize;
      const safety_tolerance = imageConfig?.safety_tolerance || toolSafetyTolerance;
      const output_format = imageConfig?.output_format ?? 'png';
      const prompt_upsampling = imageConfig?.prompt_upsampling ?? false;
      const seed = imageConfig?.seed;
      // BFL-specific parameters (not in imageConfig, use defaults or tool call override)
      const steps = toolSteps || 50;
      const guidance = toolGuidance || 60;

      // Determine which service to use based on the EDIT model (not generation model)
      const isBFLModel = isBflImageModel(editModel);
      const isGeminiModel = isGeminiImageModel(editModel);
      // Real provider for the moderation incident audit record - more accurate
      // than a generic lookup since the branch below already knows which backend is used.
      const provider = isBFLModel ? 'bfl' : isGeminiModel ? 'gemini' : 'openai';

      // Call onStart callback for credit validation
      await context.onStart?.('edit_image', {
        model,
        n,
        size,
        quality: imageConfig?.quality,
        prompt,
      });

      // Resolve the source image (URL, fabFile ObjectId, or generated-image key)
      // so the model can edit a previously generated image, not just uploads.
      const sourceImageUrl = await resolveImageInputUrl(toolImage, context);
      const sourceBase64Image = await imageUrlToBase64(sourceImageUrl);

      // Mask (optional) uses the same resolution as the source.
      let maskBase64Image: string | null = null;
      if (toolMask) {
        const maskImageUrl = await resolveImageInputUrl(toolMask, context);
        maskBase64Image = await imageUrlToBase64(maskImageUrl);
      }

      if (isBFLModel) {
        const apiKey = await getEffectiveApiKey(context.userId, { type: ApiKeyType.bfl }, { db: context.db });
        const service = new BFLImageService(apiKey!, context.logger, context.imageProcessorLambdaName);

        // Use the specified edit model (should be FLUX_PRO_FILL for BFL editing)
        let bflModel = editModel;

        // Validate BFL edit model - only FLUX_PRO_FILL supports mask-based editing
        if (bflModel !== ImageModels.FLUX_PRO_FILL) {
          Logger.globalInstance.warn(
            `[WARN] BFL edit model ${bflModel} does not support editing. Falling back to FLUX_PRO_FILL.`
          );
          bflModel = ImageModels.FLUX_PRO_FILL;
        }

        // BFL requires a mask - auto-generate if not provided
        if (!maskBase64Image) {
          const sourceBuffer = Buffer.from(sourceBase64Image, 'base64');
          maskBase64Image = await generateFullMask(sourceBuffer);
        }

        try {
          const editResponse = await service.edit(sourceBase64Image, prompt, {
            mask: maskBase64Image,
            model: bflModel,
            safety_tolerance: safety_tolerance ?? BFL_SAFETY_TOLERANCE.DEFAULT,
            prompt_upsampling,
            seed: seed ?? undefined,
            output_format: output_format ?? 'jpeg',
            steps,
            guidance,
          });

          if (editResponse.type === 'success') {
            const storedImagePath = await processAndStoreImage(editResponse.dataUrl, context, model, provider);

            return updateQuestAndReturnMarkdown(storedImagePath, context);
          }
          // Handle clarification response (TypeScript knows it must be clarification after success check)
          return `Error: ${'question' in editResponse ? editResponse.question : 'Failed to edit image'}`;
        } catch (error) {
          Logger.globalInstance.error('[ERROR] BFL image editing failed:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const responseData = error.response?.data;

            if (status === 403) {
              return `Error: BFL API access denied (403). This usually means:
- Your BFL API key is not set, invalid, or expired
- Your BFL account lacks permissions for FLUX-PRO-FILL
- Your BFL API credits have run out

Please check your BFL API key in settings and ensure it is configured correctly.`;
            } else if (status === 429) {
              return `Error: BFL API rate limit exceeded (429). Please wait a moment and try again.`;
            } else if (status === 402) {
              return `Error: BFL API payment required (402). Please add credits to your BFL account.`;
            } else if (responseData?.error) {
              return `Error: BFL API error - ${responseData.error}`;
            }
          }

          return `Error: Failed to edit image with FLUX-PRO-FILL. ${errorMessage}. Please try a different edit model like GPT-Image-1.5 or Gemini.`;
        }
      } else if (isGeminiModel) {
        // Gemini model - does not support masks, uses natural language editing
        const apiKey = await getEffectiveApiKey(context.userId, { type: ApiKeyType.gemini }, { db: context.db });
        const service = new GeminiImageService(apiKey!, context.logger, context.imageProcessorLambdaName);

        // Convert base64 image to data URL format for Gemini
        const dataUrlImage = sourceBase64Image.startsWith('data:')
          ? sourceBase64Image
          : `data:image/png;base64,${sourceBase64Image}`;

        try {
          const editResponse = await service.edit(dataUrlImage, prompt, {
            aspect_ratio: imageConfig?.aspect_ratio,
            output_format: output_format ?? 'png',
            safety_tolerance: safety_tolerance,
            model: editModel, // Pass edit model to service
          });

          if (editResponse.type === 'success') {
            const storedImagePath = await processAndStoreImage(editResponse.dataUrl, context, model, provider);

            return updateQuestAndReturnMarkdown(storedImagePath, context);
          }
          // Handle clarification response (TypeScript knows it must be clarification after success check)
          return `Error: ${'question' in editResponse ? editResponse.question : 'Failed to edit image'}`;
        } catch (error) {
          Logger.globalInstance.error('[ERROR] Gemini image editing failed:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const responseData = error.response?.data;

            if (status === 403 || status === 401) {
              return `Error: Gemini API access denied (${status}). Your Gemini API key may be missing, invalid, or expired. Please check your Gemini API key in settings.`;
            } else if (status === 429) {
              return `Error: Gemini API rate limit exceeded (429). Please wait a moment and try again.`;
            } else if (responseData?.error) {
              return `Error: Gemini API error - ${JSON.stringify(responseData.error)}`;
            }
          }

          return `Error: Failed to edit image with Gemini. ${errorMessage}. Please try a different edit model like GPT-Image-1.5.`;
        }
      } else {
        // OpenAI model (default fallback)
        const apiKey = await getEffectiveApiKey(context.userId, { type: ApiKeyType.openai }, { db: context.db });
        const service = new OpenAIImageService(apiKey!, context.logger, context.imageProcessorLambdaName);

        try {
          const editResponse = await service.edit(sourceBase64Image, prompt, {
            mask: maskBase64Image,
            model: editModel, // Use the configured edit model
            n,
            size,
            response_format: 'url',
            user: context.userId,
          });

          if (editResponse.type === 'success') {
            const storedImagePath = await processAndStoreImage(editResponse.dataUrl, context, model, provider);

            return updateQuestAndReturnMarkdown(storedImagePath, context);
          }
          // Handle clarification response (TypeScript knows it must be clarification after success check)
          return `Error: ${'question' in editResponse ? editResponse.question : 'Failed to edit image'}`;
        } catch (error) {
          Logger.globalInstance.error('[ERROR] OpenAI image editing failed:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const responseData = error.response?.data;

            if (status === 403 || status === 401) {
              return `Error: OpenAI API access denied (${status}). Your OpenAI API key may be missing, invalid, or expired. Please check your OpenAI API key in settings.`;
            } else if (status === 429) {
              return `Error: OpenAI API rate limit exceeded (429). Please wait a moment and try again.`;
            } else if (status === 402) {
              return `Error: OpenAI API payment required (402). Please add credits to your OpenAI account.`;
            } else if (responseData?.error) {
              return `Error: OpenAI API error - ${responseData.error.message || JSON.stringify(responseData.error)}`;
            }
          }

          return `Error: Failed to edit image with OpenAI. ${errorMessage}. Please try again or use a different edit model.`;
        }
      }
    },
    toolSchema: {
      name: 'edit_image',
      description:
        'Edit an existing image based on a text prompt. Use this when the user wants to modify, change, edit, or transform an image — whether they uploaded/attached it OR it was generated earlier in this conversation (e.g. "make the previous image more cartoonish", "adjust the angle"). Supports removing backgrounds, changing colors, adding/removing objects, and other visual modifications.',
      parameters: {
        type: 'object',
        properties: {
          image: {
            type: 'string',
            description:
              'The image to edit. Provide one of: the exact id of a previously generated image from the "Recently generated images" system note (e.g. "86cdc650-43d2-416e-aca6-23ff4fe23081.jpg"); a fabFile ID of an uploaded image from the "Available Files" system message (e.g. "67abc123def456"); or a full http(s)/data URL.',
          },
          prompt: {
            type: 'string',
            description: 'The prompt describing how to edit the image',
          },
          mask: {
            type: 'string',
            description:
              'Optional mask image (URL, data URL, or file ID) to specify which areas to edit. Required for BFL models. Not supported by Gemini models.',
          },
          size: {
            type: 'string',
            description: 'The size of the edited image (OpenAI only)',
            enum: ['256x256', '512x512', '1024x1024'],
          },
          n: {
            type: 'number',
            description: 'Number of edited images to generate (OpenAI only)',
          },
          safety_tolerance: {
            type: 'number',
            description: 'Safety tolerance level for BFL models (0 most strict, 6 least strict)',
            minimum: BFL_SAFETY_TOLERANCE.MIN,
            maximum: BFL_SAFETY_TOLERANCE.MAX,
          },
          steps: {
            type: 'number',
            description: 'Number of steps for BFL models (default: 50)',
          },
          guidance: {
            type: 'number',
            description: 'Guidance scale for BFL models (default: 60)',
          },
        },
        additionalProperties: false,
        required: ['image', 'prompt'],
      },
    },
  }),
};
