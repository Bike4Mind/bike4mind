import { XAI_IMAGE_MODELS, type StoredImageRequest } from '@bike4mind/common';
import { XAIImageService } from '../../imageGeneration/XAIImageService';
import type { ProviderContext, ProviderOutput, ProviderTerminalResult } from '../../generationProviders/types';
import { classifyImageProviderError, downloadImageOutput, raceAbort } from '../shared';
import type { ImageInputs, SyncImageProvider } from '../types';

/**
 * Grok Imagine through the existing XAIImageService, one image per call. The catalog offers generate only, with no
 * inputs, size or format, so the prompt is the whole request. xAI answers with a short-lived delivery URL, which
 * the store step downloads.
 */
export class XaiImageProvider implements SyncImageProvider {
  readonly mode = 'sync' as const;
  readonly id = 'xai' as const;
  readonly models = XAI_IMAGE_MODELS;

  async generate(
    request: StoredImageRequest,
    _inputs: ImageInputs,
    ctx: ProviderContext
  ): Promise<ProviderTerminalResult> {
    if (request.mode !== 'generate') throw new Error(`xAI image models do not support ${request.mode} mode`);
    const service = new XAIImageService(ctx.apiKey, ctx.logger);
    let urls: string[];
    try {
      urls = await raceAbort(service.generate(request.prompt, { n: 1 }), ctx.signal);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const classified = classifyImageProviderError(error);
      if (classified) return classified;
      throw error;
    }
    const [url] = urls;
    if (!url) throw new Error('xAI returned no image');
    return { status: 'succeeded', output: { kind: 'url', url, requiresAuth: false } };
  }

  async fetchOutput(output: ProviderOutput, ctx: ProviderContext): Promise<Buffer> {
    return downloadImageOutput(output, ctx.signal);
  }
}
