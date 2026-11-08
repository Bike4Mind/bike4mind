import { OPENAI_IMAGE_MODELS, type StoredImageRequest } from '@bike4mind/common';
import { OpenAIImageService, type OpenAIImageGenerationOptions } from '../../imageGeneration/OpenAIImageService';
import type { ProviderContext, ProviderOutput, ProviderTerminalResult } from '../../generationProviders/types';
import {
  classifyImageProviderError,
  dataUrlToOutput,
  decodeInlineOutput,
  inputsWithRole,
  raceAbort,
  toDataUrl,
} from '../shared';
import type { ImageInputs, ImageProvider } from '../types';

export type OpenAIImageProviderOptions = {
  /** The ImageProcessor Lambda, which a masked edit needs (the mask is converted to PNG there). Read per call. */
  imageProcessorLambdaName?: () => string | undefined;
};

// The SDK's option types are narrower string unions than the validated request's; the catalog already checked them.
type SdkSize = OpenAIImageGenerationOptions['size'];

/**
 * gpt-image models through the existing OpenAIImageService, one image per call. `generate` mode renders from the
 * prompt (references go through the edit endpoint, as the chat path does); `edit` mode edits the edit_source image,
 * optionally masked.
 */
export class OpenAIImageProvider implements ImageProvider {
  readonly mode = 'sync' as const;
  readonly id = 'openai' as const;
  readonly models = OPENAI_IMAGE_MODELS;

  constructor(private readonly options: OpenAIImageProviderOptions = {}) {}

  async generate(
    request: StoredImageRequest,
    inputs: ImageInputs,
    ctx: ProviderContext
  ): Promise<ProviderTerminalResult> {
    const service = new OpenAIImageService(ctx.apiKey, ctx.logger, this.options.imageProcessorLambdaName?.());
    let dataUrl: string;
    try {
      dataUrl = await raceAbort(this.render(service, request, inputs), ctx.signal);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const classified = classifyImageProviderError(error);
      if (classified) return classified;
      throw error;
    }
    return { status: 'succeeded', output: dataUrlToOutput(dataUrl) };
  }

  async fetchOutput(output: ProviderOutput, ctx: ProviderContext): Promise<Buffer> {
    ctx.signal.throwIfAborted();
    return decodeInlineOutput(output);
  }

  private async render(service: OpenAIImageService, request: StoredImageRequest, inputs: ImageInputs): Promise<string> {
    const references = inputsWithRole(inputs, 'reference').map(toDataUrl);
    const shared = {
      model: request.model,
      ...(request.quality !== undefined && { quality: request.quality }),
      ...(request.outputFormat !== undefined && { output_format: request.outputFormat }),
      ...(request.transparentBackground && { background: 'transparent' as const }),
    };

    if (request.mode === 'edit') {
      const [source] = inputsWithRole(inputs, 'edit_source');
      if (!source) throw new Error('edit request reached the provider without an edit_source image');
      const [mask] = inputsWithRole(inputs, 'mask');
      const response = await service.edit(toDataUrl(source), request.prompt, {
        ...shared,
        ...(request.size !== undefined && { size: request.size }),
        ...(mask && { mask: toDataUrl(mask) }),
        ...(references.length > 0 && { referenceImages: references }),
      });
      if (response.type !== 'success') throw new Error('OpenAI image edit asked for clarification');
      return response.dataUrl;
    }

    // The service routes a request with an image through the edit endpoint; the first reference takes that slot.
    const [imagePrompt, ...referenceImages] = references;
    const images = await service.generate(request.prompt, {
      ...shared,
      ...(request.size !== undefined && { size: request.size as SdkSize }),
      n: 1,
      ...(imagePrompt && { imagePrompt }),
      ...(referenceImages.length > 0 && { referenceImages }),
    });
    const [image] = images;
    if (!image) throw new Error('OpenAI returned no image');
    return image;
  }
}
