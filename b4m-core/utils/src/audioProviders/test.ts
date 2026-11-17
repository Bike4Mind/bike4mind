import type {
  ProviderContext,
  ProviderOutput,
  ProviderTerminalResult,
  SyncGenerationProvider,
} from '../generationProviders/types';
import { ProviderSubmitError } from '../generationProviders/types';
import { silentMp3 } from '../musicProviders/test/TestMusicProvider';
import { decodeInlineOutput } from './errors';
import type { SoundEffectProviderRequest } from './soundEffect';
import type { SpeechProviderRequest } from './speech';

const DEFAULT_SECONDS = 1;

/** Prompt markers pick the outcome: "[blocked]", "[fail]", "[retry]" (a 429), "[throw]" (unknown outcome). */
const createTestAudioProvider = <TRequest extends { text: string }, TId extends string>(
  id: TId,
  model: string,
  secondsOf: (request: TRequest) => number
): SyncGenerationProvider<TId, string, TRequest> => ({
  mode: 'sync',
  id,
  models: [model],

  async generate(request: TRequest, _inputs, ctx: ProviderContext): Promise<ProviderTerminalResult> {
    ctx.signal.throwIfAborted();
    const { text } = request;
    if (text.includes('[throw]')) throw new ProviderSubmitError('test provider transport failure', false);
    if (text.includes('[blocked]')) return { status: 'blocked', reason: 'test policy block', raw: { text } };
    if (text.includes('[fail]')) {
      return { status: 'failed', retryable: false, message: 'test provider failure', raw: { text } };
    }
    if (text.includes('[retry]')) {
      return { status: 'failed', retryable: true, message: 'test provider rate limited', raw: { text } };
    }
    return {
      status: 'succeeded',
      output: { kind: 'inline', base64: silentMp3(secondsOf(request)).toString('base64'), contentType: 'audio/mpeg' },
    };
  },

  async fetchOutput(output: ProviderOutput, ctx: ProviderContext): Promise<Buffer> {
    ctx.signal.throwIfAborted();
    return decodeInlineOutput(output);
  },
});

// Typed as the vendor unions' members so these register in the same slots as the real providers.
export const testSpeechProvider = createTestAudioProvider<SpeechProviderRequest, 'test'>(
  'test',
  'test-speech',
  () => DEFAULT_SECONDS
);

export const testSoundEffectProvider = createTestAudioProvider<SoundEffectProviderRequest, 'test'>(
  'test',
  'test-sound-effect',
  request => request.durationSeconds ?? DEFAULT_SECONDS
);
