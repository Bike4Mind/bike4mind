import { GEMINI_IMAGE_MODELS, type StoredImageRequest } from '@bike4mind/common';
import { GeminiImageService } from '../../imageGeneration/GeminiImageService';
import type { ProviderContext, ProviderOutput, ProviderTerminalResult } from '../../generationProviders/types';
import {
  classifyImageProviderError,
  dataUrlToOutput,
  decodeInlineOutput,
  inputsWithRole,
  raceAbort,
  toDataUrl,
} from '../shared';
import type { ImageInputs, SyncImageProvider } from '../types';

type Rendered = { kind: 'image'; dataUrl: string } | { kind: 'clarification'; question: string };

/**
 * gemini-*-image models through the existing GeminiImageService, one image per call. The catalog allows no sizing,
 * format, quality or seed for these models, so only the prompt and the input image reach Gemini. A generate
 * reference makes it image-to-image, which the service serves through its edit call (as the chat path does).
 */
export class GeminiImageProvider implements SyncImageProvider {
  readonly mode = 'sync' as const;
  readonly id = 'gemini' as const;
  readonly models = GEMINI_IMAGE_MODELS;

  async generate(
    request: StoredImageRequest,
    inputs: ImageInputs,
    ctx: ProviderContext
  ): Promise<ProviderTerminalResult> {
    const service = new GeminiImageService(ctx.apiKey, ctx.logger);
    let rendered: Rendered;
    try {
      rendered = await raceAbort(() => this.render(service, request, inputs), ctx.signal);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const classified = classifyImageProviderError(error);
      if (classified) return classified;
      throw error;
    }
    if (rendered.kind === 'clarification') {
      // Gemini answered in text and made no image: a definitive outcome, and the same prompt asks the same again.
      return {
        status: 'failed',
        retryable: false,
        message: `Gemini asked for clarification instead of making an image: ${rendered.question}`,
        raw: null,
      };
    }
    return { status: 'succeeded', output: dataUrlToOutput(rendered.dataUrl) };
  }

  async fetchOutput(output: ProviderOutput, ctx: ProviderContext): Promise<Buffer> {
    ctx.signal.throwIfAborted();
    return decodeInlineOutput(output);
  }

  private async render(
    service: GeminiImageService,
    request: StoredImageRequest,
    inputs: ImageInputs
  ): Promise<Rendered> {
    const role = request.mode === 'edit' ? 'edit_source' : 'reference';
    const [image] = inputsWithRole(inputs, role);
    if (!image) {
      if (request.mode === 'edit') throw new Error('edit request reached the provider without an edit_source image');
      const [dataUrl] = await service.generate(request.prompt, { model: request.model, n: 1 });
      if (!dataUrl) throw new Error('Gemini returned no image');
      return { kind: 'image', dataUrl };
    }
    const response = await service.edit(toDataUrl(image), request.prompt, { model: request.model });
    return response.type === 'success'
      ? { kind: 'image', dataUrl: response.dataUrl }
      : { kind: 'clarification', question: response.question };
  }
}
