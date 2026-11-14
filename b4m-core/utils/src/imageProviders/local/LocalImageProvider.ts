import { isLocalImageModelId, type StoredImageRequest } from '@bike4mind/common';
import { LocalImageService } from '../../imageGeneration/LocalImageService';
import type { ProviderContext, ProviderOutput, ProviderTerminalResult } from '../../generationProviders/types';
import { classifyImageProviderError, dataUrlToOutput, decodeInlineOutput, raceAbort } from '../shared';
import type { ImageInputs, SyncImageProvider } from '../types';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A self-hosted Stable Diffusion server through the existing LocalImageService, one image per call. Its checkpoints
 * are discovered at runtime, so `models` is empty: every `local-image/<checkpoint>` id resolves to this provider
 * through the catalog. `ctx.apiKey` carries the server's base URL (IMAGE_GEN_BASE_URL), the slot the legacy service
 * already uses for it.
 *
 * The render runs on the operator's own hardware and costs nothing, so a server error is a plain failure rather than
 * an unknown outcome: nobody is billed twice if the user tries again. Only an aborted step (the lease ran out) is
 * rethrown, since the render may still be running.
 */
export class LocalImageProvider implements SyncImageProvider {
  readonly mode = 'sync' as const;
  readonly id = 'local' as const;
  readonly models = [] as const;

  async generate(
    request: StoredImageRequest,
    _inputs: ImageInputs,
    ctx: ProviderContext
  ): Promise<ProviderTerminalResult> {
    if (request.mode !== 'generate' || !isLocalImageModelId(request.model)) {
      const message = `the local image server cannot run ${request.mode} with ${request.model}`;
      return { status: 'failed', retryable: false, message, raw: { mode: request.mode, model: request.model } };
    }
    const service = new LocalImageService(ctx.apiKey, ctx.logger);
    let dataUrls: string[];
    try {
      dataUrls = await raceAbort(
        () => service.generate(request.prompt, { n: 1, model: request.model, size: request.size }),
        ctx.signal
      );
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      return (
        classifyImageProviderError(error) ?? { status: 'failed', retryable: false, message: messageOf(error), raw: {} }
      );
    }
    const [dataUrl] = dataUrls;
    if (!dataUrl)
      return { status: 'failed', retryable: false, message: 'the local image server returned no image', raw: {} };
    return { status: 'succeeded', output: dataUrlToOutput(dataUrl) };
  }

  async fetchOutput(output: ProviderOutput, ctx: ProviderContext): Promise<Buffer> {
    ctx.signal.throwIfAborted();
    return decodeInlineOutput(output);
  }
}
