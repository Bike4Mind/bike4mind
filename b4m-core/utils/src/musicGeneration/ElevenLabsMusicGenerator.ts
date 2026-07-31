import { DEFAULT_MUSIC_MODEL_ID } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { GeneratedMusic, MusicGenerationOptions, MusicGenerator } from './types';

const MUSIC_GENERATION_ENDPOINT = 'https://api.elevenlabs.io/v1/music';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

/** Maps an ElevenLabs `output_format` token to its MIME type. */
function contentTypeForFormat(format: string): string {
  if (format.startsWith('mp3')) return 'audio/mpeg';
  if (format.startsWith('opus')) return 'audio/opus';
  if (format.startsWith('pcm')) return 'audio/L16';
  if (format.startsWith('ulaw')) return 'audio/basic';
  return 'application/octet-stream';
}

export interface ElevenLabsMusicGeneratorConfig {
  apiKey: string;
  logger: Logger;
  /** Injectable HTTP client; defaults to the global `fetch`. Overridden in tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Generates background music via the ElevenLabs `POST /v1/music` API.
 * See https://elevenlabs.io/docs/api-reference/music.
 *
 * `music_length_ms` is always sent when a length is provided so the generated
 * track length is deterministic and matches what the caller was billed for.
 */
export class ElevenLabsMusicGenerator implements MusicGenerator {
  private readonly apiKey: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ElevenLabsMusicGeneratorConfig) {
    if (!config.apiKey) {
      throw new Error('ElevenLabs API key is required for music generation');
    }
    this.apiKey = config.apiKey;
    this.logger = config.logger;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async generate(prompt: string, options: MusicGenerationOptions = {}): Promise<GeneratedMusic> {
    const format = options.format ?? DEFAULT_OUTPUT_FORMAT;
    const url = new URL(MUSIC_GENERATION_ENDPOINT);
    url.searchParams.set('output_format', format);

    const res = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        model_id: options.modelId ?? DEFAULT_MUSIC_MODEL_ID,
        ...(options.lengthMs !== undefined ? { music_length_ms: options.lengthMs } : {}),
        ...(options.forceInstrumental !== undefined ? { force_instrumental: options.forceInstrumental } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error('ElevenLabs music generation failed', { status: res.status, detail });
      throw new Error(`ElevenLabs music generation failed: ${res.status} ${detail}`);
    }

    const audio = Buffer.from(await res.arrayBuffer());
    return { audio, contentType: contentTypeForFormat(format) };
  }
}
