import { Logger } from '@bike4mind/observability';
import { ToolContext, ToolDefinition } from '../../base/types';
import {
  ApiKeyType,
  BFL_IMAGE_MODELS,
  ImageModels,
  BFL_SAFETY_TOLERANCE,
  XAI_IMAGE_MODELS,
  GEMINI_IMAGE_MODELS,
  GenerateImageToolCall,
} from '@bike4mind/common';
import {
  OpenAIImageService,
  XAIImageService,
  GeminiImageService,
  getSettingsMap,
  getSettingsValue,
  RekognitionImageModerationService,
} from '@bike4mind/utils';
import { BFLImageService } from '@bike4mind/utils';
import { ImageGenerateParams } from 'openai/resources/images';
import { getEffectiveApiKey } from '../../../../apiKeyService';
import axios from 'axios';
import { fileTypeFromBuffer } from 'file-type';
import { v4 as uuidv4 } from 'uuid';
import { persistGeneratedFileAsFabFile } from '../../helpers/persistGeneratedFile';
import { moderateImageOrThrow } from '../../../imageModerationGate';

async function downloadImage(url: string) {
  // Handle data URLs (base64 images) from GPT-Image-1
  if (url.startsWith('data:image/')) {
    const base64Data = url.split(',')[1];
    return Buffer.from(base64Data, 'base64');
  }

  // Handle regular URLs from DALL-E and other models
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return response.data;
}

/**
 * Validate that an image-generation provider's API key is present. Without
 * this guard, `apiKey!` passes `undefined` through to the provider service,
 * which sends an empty auth header and the API responds with a generic 401
 * - the ReAct loop sees an opaque "Request failed with status code 401"
 * observation and (reasonably) retries the same call, creating an infinite
 * re-approval loop on the inline permission card.
 *
 * The error message that bubbles up here is what the LLM sees as the tool
 * observation AND what may be displayed inline in the iteration stream, so
 * it is intentionally generic - provider names and config details belong in
 * the server logs, not in user-visible output. In production all keys are
 * expected to be present; this path mainly trips on preview / dev envs.
 */
function requireApiKey(apiKey: string | undefined, providerLabel: string, logger?: Pick<Console, 'error'>): string {
  if (!apiKey) {
    const log = logger ?? console;
    log.error(`[image_generation] ${providerLabel} API key is not configured — refusing to dispatch`);
    throw new Error('Image generation is currently unavailable. Please try again later.');
  }
  return apiKey;
}

/**
 * The agent-tool image_generation path bypassed the moderation gate that
 * ImageGeneration.process() (queue handler) already runs before upload. This wrapper closes
 * that hole for the tool path using the SAME shared gate (`moderateImageOrThrow`).
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

export async function processAndStoreImages(
  images: string[],
  context: ToolContext,
  model: string,
  provider: string
): Promise<string[]> {
  await context.statusUpdate({}, 'Storing images...');
  return Promise.all(
    images.map(async image => {
      const buffer = await downloadImage(image);
      const fileType = await fileTypeFromBuffer(buffer);
      // Default the extension when detection fails: a `${uuid}.undefined` filename would
      // both store with a bogus extension and miss the inline-image regex in PromptReplies
      // (rendering the image as a download chip instead of in the grid).
      const ext = fileType?.ext ?? 'png';
      const mimeType = fileType?.mime ?? 'image/png';
      const filename = `${uuidv4()}.${ext}`;

      // Block moderated content BEFORE upload - see moderateToolImage doc comment.
      await moderateToolImage(context, buffer, mimeType, model, provider);

      const path = await context.imageGenerateStorage.upload(buffer, filename, {});

      // Also persist as a session FabFile so the image is browsable in the Knowledge Base
      // (the inline chat grid reads quest.images from the generated bucket; this makes the
      // same image survive as a first-class, downloadable file). Best-effort - never blocks
      // the image from rendering inline. Use a human-readable name (not the raw uuid storage
      // key) so the Knowledge Base shows a sensible title.
      await persistGeneratedFileAsFabFile(context, {
        fileName: `generated-image-${filename.slice(0, 8)}.${ext}`,
        mimeType: fileType?.mime ?? 'image/png',
        content: buffer,
      });

      return path;
    })
  );
}

async function updateQuestAndReturnMarkdown(storedImageUrls: string[], context: ToolContext): Promise<string> {
  // Call onFinish callback for credit deduction
  await context.onFinish?.('image_generation', storedImageUrls);

  // Update the quest's images array AND return markdown for compatibility
  await context.statusUpdate({ images: storedImageUrls });
  const instructions = 'Successfully generated images';
  return instructions;
}

export const imageGenerationTool: ToolDefinition = {
  name: 'image_generation',
  implementation: (context, config: GenerateImageToolCall) => ({
    toolFn: async val => {
      // Get imageConfig from config (passed from client via imageConfig).
      // When no imageConfig is pre-set, signal via pendingAction so the caller
      // can handle model selection (e.g., show a picker UI).
      const imageConfig = config;
      if (!imageConfig) {
        const { prompt } = val as { prompt?: string };
        await context.statusUpdate({
          pendingAction: {
            tool: 'image_generation',
            params: { prompt: prompt || '', userId: context.userId },
            ts: Date.now(),
          },
        });
        return 'Image model selection required. A model picker has been presented to the user.';
      }

      // Extract tool call arguments (LLM can still override via tool call)
      const {
        prompt,
        n: toolN,
        quality: toolQuality,
        size: toolSize,
        safety_tolerance: toolSafetyTolerance,
      } = val as ImageGenerateParams & {
        model?: string;
        safety_tolerance?: number;
      };

      // Use imageConfig settings as defaults, allow tool call to override
      // Auto-upgrade gpt-image-1 to gpt-image-2 (latest model)
      let model = imageConfig?.model || ImageModels.GPT_IMAGE_2;
      if (model === ImageModels.GPT_IMAGE_1) {
        model = ImageModels.GPT_IMAGE_2;
      }
      const n = toolN ?? imageConfig?.n ?? 1;
      const quality = imageConfig?.quality || toolQuality;
      const size = imageConfig?.size || toolSize;
      const safety_tolerance = imageConfig?.safety_tolerance || toolSafetyTolerance;
      const width = imageConfig?.width;
      const height = imageConfig?.height;
      const aspect_ratio = imageConfig?.aspect_ratio;
      const output_format = imageConfig?.output_format;
      const prompt_upsampling = imageConfig?.prompt_upsampling;
      const seed = imageConfig?.seed;

      // Determine which service to use based on the model
      const isBFLModel = BFL_IMAGE_MODELS.includes(model as any);
      const isXAIModel = XAI_IMAGE_MODELS.includes(model as any);
      const isGeminiModel = GEMINI_IMAGE_MODELS.includes(model as any);
      // Real provider for the moderation incident audit record - more accurate
      // than a generic lookup since the branch below already knows which backend is used.
      const provider = isXAIModel ? 'xai' : isBFLModel ? 'bfl' : isGeminiModel ? 'gemini' : 'openai';

      // Call onStart callback for credit validation
      await context.onStart?.('image_generation', {
        model,
        n,
        size,
        quality,
        prompt,
      });

      await context.statusUpdate({}, 'Now painting image...');

      if (isXAIModel) {
        const apiKey = await getEffectiveApiKey(context.userId, { type: ApiKeyType.xai }, { db: context.db });
        const service = new XAIImageService(requireApiKey(apiKey, 'xAI (Grok)', context.logger), context.logger);

        const images = await service.generate(prompt, {
          n,
          model: model as any,
          size: size as any,
          user: context.userId,
          safety_tolerance,
        });

        const storedImageUrls = await processAndStoreImages(images, context, model, provider);

        return updateQuestAndReturnMarkdown(storedImageUrls, context);
      } else if (isBFLModel) {
        const apiKey = await getEffectiveApiKey(context.userId, { type: ApiKeyType.bfl }, { db: context.db });
        const service = new BFLImageService(
          requireApiKey(apiKey, 'Black Forest Labs (BFL)', context.logger),
          context.logger
        );

        // Use the model from imageConfig (or tool call override)
        const bflModel = model;

        try {
          const images = await service.generate(prompt, {
            n,
            model: bflModel as any,
            width: width ?? 1024,
            height: height ?? 768,
            aspect_ratio: aspect_ratio,
            output_format: output_format ?? 'png',
            prompt_upsampling: prompt_upsampling ?? false,
            seed: seed ?? undefined,
            user: context.userId,
            safety_tolerance: safety_tolerance ?? BFL_SAFETY_TOLERANCE.DEFAULT,
          });

          const storedImageUrls = await processAndStoreImages(images, context, model, provider);

          return updateQuestAndReturnMarkdown(storedImageUrls, context);
        } catch (bflError) {
          // Log status + message only. Never log the raw AxiosError: its
          // `config.headers` carries the BFL `x-key`, which would leak the API
          // key into CloudWatch in plaintext.
          const status = axios.isAxiosError(bflError) ? bflError.response?.status : undefined;
          const message = bflError instanceof Error ? bflError.message : 'Unknown error';
          Logger.globalInstance.error(`[ERROR] BFL image generation failed (status: ${status ?? 'n/a'}): ${message}`);

          if (axios.isAxiosError(bflError)) {
            const responseData = bflError.response?.data;
            if (status === 402) {
              return `Error: BFL API payment required (402). The image generation API has insufficient credits. Please add credits to the BFL account at https://api.bfl.ai.`;
            }
            if (status === 401) {
              return `Error: BFL API authentication failed (401). Please check your BFL API key configuration.`;
            }
            // BFL has historically returned 403 for both unauthorized-key and
            // exhausted-credit cases, mirroring the imageEdit tool's handling.
            if (status === 403) {
              return `Error: BFL API access denied (403). Your BFL API key may be missing, invalid, or expired, your account may lack permissions, or your credits may have run out. Please check your BFL API key configuration.`;
            }
            if (status === 429) {
              return `Error: BFL API rate limit exceeded (429). Please wait a moment and try again.`;
            }
            if (responseData?.error) {
              return `Error: BFL API error - ${responseData.error}`;
            }
          }
          throw bflError;
        }
      } else if (isGeminiModel) {
        Logger.globalInstance.log(`Generating image using Gemini model`);
        const apiKey = await getEffectiveApiKey(context.userId, { type: ApiKeyType.gemini }, { db: context.db });
        const service = new GeminiImageService(requireApiKey(apiKey, 'Google Gemini', context.logger), context.logger);

        const images = await service.generate(prompt, {
          n,
          model,
          aspect_ratio: aspect_ratio,
          output_format: output_format ?? 'png',
          safety_tolerance: safety_tolerance,
        });

        const storedImageUrls = await processAndStoreImages(images, context, model, provider);

        return updateQuestAndReturnMarkdown(storedImageUrls, context);
      } else {
        const apiKey = await getEffectiveApiKey(context.userId, { type: ApiKeyType.openai }, { db: context.db });
        const service = new OpenAIImageService(requireApiKey(apiKey, 'OpenAI', context.logger), context.logger);

        // Scope the catch to the OpenAI call only - processAndStoreImages / updateQuestAndReturnMarkdown
        // are S3/Mongo work whose failures must not be mislabeled as an OpenAI image error.
        let images;
        try {
          images = await service.generate(prompt, {
            n,
            quality,
            size: size as any,
            model,
            user: context.userId,
            safety_tolerance,
          });
        } catch (openaiError) {
          // OpenAIImageService maps known API failures (402/401/403/429, moderation) to friendly
          // messages; return them as the tool result so the model can relay a clear reason instead
          // of the run dying with a generic "Agent execution failed".
          const message = openaiError instanceof Error ? openaiError.message : 'Unknown error';
          console.error(`[ERROR] OpenAI image generation failed (model: ${model}): ${message}`);
          return `Error: ${message}`;
        }

        const storedImageUrls = await processAndStoreImages(images, context, model, provider);

        return updateQuestAndReturnMarkdown(storedImageUrls, context);
      }
    },
    toolSchema: {
      name: 'image_generation',
      description:
        '🎨 IMAGE GENERATION TOOL: Use this tool when user wants to create, generate, draw, paint, or make an image/picture/illustration/artwork. ALWAYS use this for phrases like "generate an image", "create a picture", "draw me", "make an image of", "illustrate", "show me a picture of". This tool creates AI-generated images from text descriptions. DO NOT use blog_draft or other tools for image generation requests. IMPORTANT: Pass the user\'s COMPLETE prompt to this tool. Include ALL subjects, styles, and details in a SINGLE call. Do NOT split multi-subject requests into separate calls. Do NOT omit subjects or simplify the prompt.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              "The image generation prompt. Use the user's original prompt as closely as possible — include ALL requested subjects, styles, and details in one prompt. Do not split into separate calls.",
          },
          size: {
            type: 'string',
            description: 'The size of the image to generate (OpenAI only)',
            enum: ['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792'],
          },
          quality: {
            type: 'string',
            description: 'The quality of the image that will be generated (OpenAI only)',
            enum: ['standard', 'hd'],
          },
          n: {
            type: 'number',
            description: 'Number of images to generate',
          },
          safety_tolerance: {
            type: 'number',
            description: 'Safety tolerance level for BFL models (0 most strict, 6 least strict)',
            minimum: BFL_SAFETY_TOLERANCE.MIN,
            maximum: BFL_SAFETY_TOLERANCE.MAX,
          },
        },
        additionalProperties: false,
        required: ['prompt'],
      },
    },
  }),
};
