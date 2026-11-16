import { DEFAULT_SOUND_MODEL_ID, type SoundGenerationVendor } from '@bike4mind/common';
import type {
  ProviderContext,
  ProviderOutput,
  ProviderTerminalResult,
  SyncGenerationProvider,
} from '../generationProviders/types';
import { aiSoundService } from '../soundGeneration';
import { decodeInlineOutput, toAudioProviderResult } from './errors';

export type SoundEffectProviderRequest = {
  text: string;
  durationSeconds?: number;
  promptInfluence?: number;
  format?: string;
};

export type SoundEffectProvider = SyncGenerationProvider<SoundGenerationVendor, string, SoundEffectProviderRequest>;

export const createSoundEffectProvider = (vendor: SoundGenerationVendor): SoundEffectProvider => ({
  mode: 'sync',
  id: vendor,
  models: [DEFAULT_SOUND_MODEL_ID],

  async generate(request: SoundEffectProviderRequest, _inputs, ctx: ProviderContext): Promise<ProviderTerminalResult> {
    try {
      const sound = await aiSoundService(vendor, ctx.apiKey, ctx.logger).generate(request.text, {
        durationSeconds: request.durationSeconds,
        promptInfluence: request.promptInfluence,
        format: request.format,
        signal: ctx.signal,
      });
      return {
        status: 'succeeded',
        output: { kind: 'inline', base64: sound.audio.toString('base64'), contentType: sound.contentType },
      };
    } catch (error) {
      return toAudioProviderResult(error, `${vendor}_sound_effect`);
    }
  },

  async fetchOutput(output: ProviderOutput): Promise<Buffer> {
    return decodeInlineOutput(output);
  },
});
