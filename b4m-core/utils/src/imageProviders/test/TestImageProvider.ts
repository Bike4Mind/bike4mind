import { TEST_IMAGE_MODEL, type StoredImageRequest } from '@bike4mind/common';
import {
  ProviderSubmitError,
  type ProviderContext,
  type ProviderOutput,
  type ProviderTerminalResult,
} from '../../generationProviders/types';
import { decodeInlineOutput } from '../shared';
import type { ImageInputs, SyncImageProvider } from '../types';

// A 128x128 solid-blue PNG: large enough for the image moderation scan, small enough to inline.
export const TEST_IMAGE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAAyElEQVR42u3RMQ0AAAgEsfeFO0QzIwOGJqfgmurRYbEAAAABACAAAAQAgAAAEAAAAgBAAAAIAAABACAAAAQAgAAAEAAAAgBAAAAIAAABACAAAAQAgAAAEAAAAgBAAAAIAAABACAAAAQAgAAAEAAAAgBAAAAAcAEAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAAC8KEFcYnGVYL2pKUAAAAASUVORK5CYII=';

/**
 * Deterministic, free sync provider for non-production E2E, like the video and music test providers. Prompt markers
 * pick the outcome: "[blocked]" is a policy block, "[fail]" a non-retryable failure, "[retry]" a retryable one (a 429),
 * "[throw]" an unknown outcome. Inputs are accepted and ignored, so edit and reference flows run without a provider.
 */
export class TestImageProvider implements SyncImageProvider {
  readonly mode = 'sync' as const;
  readonly id = 'test' as const;
  readonly models = [TEST_IMAGE_MODEL] as const;

  async generate(
    request: StoredImageRequest,
    _inputs: ImageInputs,
    ctx: ProviderContext
  ): Promise<ProviderTerminalResult> {
    ctx.signal.throwIfAborted();
    const { prompt } = request;
    if (prompt.includes('[throw]')) throw new ProviderSubmitError('test provider transport failure', false);
    if (prompt.includes('[blocked]')) return { status: 'blocked', reason: 'test policy block', raw: { prompt } };
    if (prompt.includes('[fail]')) {
      return { status: 'failed', retryable: false, message: 'test provider failure', raw: { prompt } };
    }
    if (prompt.includes('[retry]')) {
      return { status: 'failed', retryable: true, message: 'test provider rate limited', raw: { prompt } };
    }
    return { status: 'succeeded', output: { kind: 'inline', base64: TEST_IMAGE_PNG_BASE64, contentType: 'image/png' } };
  }

  async fetchOutput(output: ProviderOutput, ctx: ProviderContext): Promise<Buffer> {
    ctx.signal.throwIfAborted();
    return decodeInlineOutput(output);
  }
}
