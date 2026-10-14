import type { ValidatedMusicRequest } from '@bike4mind/common';
import {
  ProviderSubmitError,
  type ProviderContext,
  type ProviderOutput,
  type ProviderTerminalResult,
  type ResolvedInputs,
  type SyncGenerationProvider,
} from '../types';

// MPEG-1 Layer III, no CRC, 32 kbps, 48 kHz, mono: 96-byte frames of 1152 samples (24 ms each).
const FRAME_HEADER = [0xff, 0xfb, 0x14, 0xc0] as const;
const FRAME_BYTES = 96;
const FRAME_SECONDS = 1152 / 48_000;

/**
 * A silent MP3 of about `seconds` (rounded up to whole frames). Every frame carries a real header and zeroed side
 * information, so decoders play silence and mp3DurationSeconds reads the length back.
 */
export const silentMp3 = (seconds: number): Buffer => {
  const frames = Math.max(1, Math.ceil(seconds / FRAME_SECONDS - 1e-9));
  const bytes = Buffer.alloc(frames * FRAME_BYTES);
  for (let offset = 0; offset < bytes.length; offset += FRAME_BYTES) bytes.set(FRAME_HEADER, offset);
  return bytes;
};

/**
 * Deterministic, free sync provider for non-production E2E. Prompt markers pick the outcome: "[blocked]" is a
 * policy block, "[fail]" a non-retryable failure, "[retry]" a retryable one (a 429), "[throw]" an unknown outcome.
 */
export class TestMusicProvider implements SyncGenerationProvider<'test', 'test-music', ValidatedMusicRequest> {
  readonly mode = 'sync' as const;
  readonly id = 'test' as const;
  readonly models = ['test-music'] as const;

  async generate(
    request: ValidatedMusicRequest,
    _inputs: ResolvedInputs,
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
    return {
      status: 'succeeded',
      output: {
        kind: 'inline',
        base64: silentMp3(request.durationSeconds).toString('base64'),
        contentType: 'audio/mpeg',
      },
      ...(request.lyrics !== undefined && { lyrics: request.lyrics }),
    };
  }

  async fetchOutput(output: ProviderOutput, ctx: ProviderContext): Promise<Buffer> {
    ctx.signal.throwIfAborted();
    if (output.kind !== 'inline') throw new Error('TestMusicProvider only produces inline output');
    return Buffer.from(output.base64, 'base64');
  }
}
