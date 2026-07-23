import { Logger } from '@bike4mind/observability';
import { GeneratedSound, SoundGenerationOptions, SoundGenerator } from './types';

const SOUND_GENERATION_ENDPOINT = 'https://api.elevenlabs.io/v1/sound-generation';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

/** Maps an ElevenLabs `output_format` token to its MIME type. */
function contentTypeForFormat(format: string): string {
  if (format.startsWith('mp3')) return 'audio/mpeg';
  if (format.startsWith('opus')) return 'audio/opus';
  if (format.startsWith('pcm')) return 'audio/L16';
  if (format.startsWith('ulaw')) return 'audio/basic';
  return 'application/octet-stream';
}

export interface ElevenLabsSoundGeneratorConfig {
  apiKey: string;
  logger: Logger;
  /** Injectable HTTP client; defaults to the global `fetch`. Overridden in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Generates sound effects via the ElevenLabs `POST /v1/sound-generation` API.
 * See https://elevenlabs.io/docs/api-reference/text-to-sound-effects.
 */
export class ElevenLabsSoundGenerator implements SoundGenerator {
  private readonly apiKey: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ElevenLabsSoundGeneratorConfig) {
    if (!config.apiKey) {
      throw new Error('ElevenLabs API key is required for sound generation');
    }
    this.apiKey = config.apiKey;
    this.logger = config.logger;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async generate(text: string, options: SoundGenerationOptions = {}): Promise<GeneratedSound> {
    const format = options.format ?? DEFAULT_OUTPUT_FORMAT;
    const url = new URL(SOUND_GENERATION_ENDPOINT);
    url.searchParams.set('output_format', format);

    const res = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text,
        ...(options.durationSeconds !== undefined ? { duration_seconds: options.durationSeconds } : {}),
        ...(options.promptInfluence !== undefined ? { prompt_influence: options.promptInfluence } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error('ElevenLabs sound generation failed', { status: res.status, detail });
      throw new Error(`ElevenLabs sound generation failed: ${res.status} ${detail}`);
    }

    const audio = Buffer.from(await res.arrayBuffer());
    return { audio, contentType: contentTypeForFormat(format) };
  }
}
