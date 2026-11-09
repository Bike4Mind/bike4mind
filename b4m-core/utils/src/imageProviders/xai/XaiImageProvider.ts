import { XAI_IMAGE_MODELS, type StoredImageRequest } from '@bike4mind/common';
import { XAIImageService } from '../../imageGeneration/XAIImageService';
import type { ProviderContext, ProviderOutput, ProviderTerminalResult } from '../../generationProviders/types';
import { classifyImageProviderError, downloadImageOutput, raceAbort } from '../shared';
import type { ImageInputs, SyncImageProvider } from '../types';

// Each SDK retry is another billed render, so the job engine owns retries; the timeout stays under a step's lease.
const XAI_JOB_CLIENT_OPTIONS = { maxRetries: 0, timeout: 4 * 60 * 1000 } as const;

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
    if (request.mode !== 'generate') {
      const message = `xAI image models do not support ${request.mode} mode`;
      return { status: 'failed', retryable: false, message, raw: { mode: request.mode } };
    }
    const service = new XAIImageService(ctx.apiKey, ctx.logger, undefined, XAI_JOB_CLIENT_OPTIONS);
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
