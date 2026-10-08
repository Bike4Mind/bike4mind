import type { ValidatedVideoRequest } from '@bike4mind/common';
import { FIXTURE_VIDEO_BASE64 } from './fixtureVideo';
import {
  ProviderSubmitError,
  type ProviderJobHandle,
  type ProviderOutput,
  type ProviderPollResult,
  type ResolvedInputs,
  type VideoProvider,
  type VideoProviderContext,
} from '../types';

const READY_AFTER_MS = 4_000;

/**
 * Deterministic, free provider for non-production E2E. Prompt markers pick the outcome:
 * "[reject]" fails submit definitively, "[blocked]" is a policy block, "[fail]" a non-retryable failure.
 */
export class TestVideoProvider implements VideoProvider {
  readonly id = 'test' as const;
  readonly models = ['test-video'] as const;

  async submit(
    request: ValidatedVideoRequest,
    _inputs: ResolvedInputs,
    ctx: VideoProviderContext
  ): Promise<ProviderJobHandle> {
    ctx.signal.throwIfAborted();
    if (request.prompt.includes('[reject]')) throw new ProviderSubmitError('test provider rejected the prompt', true);
    return {
      provider: this.id,
      data: {
        outcome: request.prompt.includes('[blocked]')
          ? 'blocked'
          : request.prompt.includes('[fail]')
            ? 'failed'
            : 'succeeded',
        readyAt: ctx.now().getTime() + READY_AFTER_MS,
        durationSeconds: request.durationSeconds,
      },
    };
  }

  async poll(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<ProviderPollResult> {
    ctx.signal.throwIfAborted();
    const readyAt = Number(handle.data.readyAt);
    if (ctx.now().getTime() < readyAt) return { status: 'running', progress: 0.5 };
    switch (handle.data.outcome) {
      case 'blocked':
        return { status: 'blocked', reason: 'test policy block', raw: handle.data };
      case 'failed':
        return { status: 'failed', retryable: false, message: 'test provider failure', raw: handle.data };
      default:
        return {
          status: 'succeeded',
          output: { kind: 'inline', base64: FIXTURE_VIDEO_BASE64, contentType: 'video/mp4' },
          reportedDurationSeconds: Number(handle.data.durationSeconds),
        };
    }
  }

  async fetchOutput(output: ProviderOutput, ctx: VideoProviderContext): Promise<Buffer> {
    ctx.signal.throwIfAborted();
    if (output.kind !== 'inline') throw new Error('TestVideoProvider only produces inline output');
    return Buffer.from(output.base64, 'base64');
  }

  async cancel(_handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<void> {
    ctx.signal.throwIfAborted();
  }
}
