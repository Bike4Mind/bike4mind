import { DEFAULT_MUSIC_LENGTH_MS, DEFAULT_MUSIC_MODEL_ID, elevenLabsContentTypeForFormat } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { parseRetryAfterMs, ProviderRateLimitError } from '../providerRateLimitError';
import { GeneratedMusic, MusicGenerationOptions, MusicGenerator } from './types';

const MUSIC_GENERATION_ENDPOINT = 'https://api.elevenlabs.io/v1/music';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

/**
 * Default provider-fetch deadline. The round-trip runs inside a time-capped
 * serving function (60s on hosted; see infra/web.ts) while a credit reservation
 * is already debited. Aborting with headroom - leaving room for the surrounding
 * reserve/settle/persist work - makes a slow provider surface as a rejected
 * fetch, which the route's catch refunds, instead of the process being killed
 * mid-call with the charge applied and no refund.
 *
 * Overridable per-instance via `timeoutMs` so a deployment without that cap
 * (self-host) isn't bound by a hosted-infra number.
 */
export const MUSIC_GENERATION_TIMEOUT_MS = 45_000;

export interface ElevenLabsMusicGeneratorConfig {
  apiKey: string;
  logger: Logger;
  /** Injectable HTTP client; defaults to the global `fetch`. Overridden in tests. */
  fetchImpl?: typeof fetch;
  /** Provider-fetch deadline; defaults to MUSIC_GENERATION_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Generates background music via the ElevenLabs `POST /v1/music` API.
 * See https://elevenlabs.io/docs/api-reference/music.
 *
 * `music_length_ms` is always sent (DEFAULT_MUSIC_LENGTH_MS when omitted, the same
 * default the cost calculator's callers bill) so the generated track length is
 * deterministic and never left to the provider's auto-duration.
 */
export class ElevenLabsMusicGenerator implements MusicGenerator {
  private readonly apiKey: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: ElevenLabsMusicGeneratorConfig) {
    if (!config.apiKey) {
      throw new Error('ElevenLabs API key is required for music generation');
    }
    this.apiKey = config.apiKey;
    this.logger = config.logger;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? MUSIC_GENERATION_TIMEOUT_MS;
  }

  async generate(prompt: string, options: MusicGenerationOptions = {}): Promise<GeneratedMusic> {
    const format = options.format ?? DEFAULT_OUTPUT_FORMAT;
    // The routes refuse an unsupported format before reserving credits; this guards any other caller
    // from paying for audio that could not be labelled.
    const contentType = elevenLabsContentTypeForFormat(format);
    if (!contentType) {
      throw new Error(`Unsupported ElevenLabs music output format: ${format}`);
    }
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
        music_length_ms: options.lengthMs ?? DEFAULT_MUSIC_LENGTH_MS,
        ...(options.forceInstrumental !== undefined ? { force_instrumental: options.forceInstrumental } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 429) {
        // The plan's concurrency/rate cap, not a fault: warn only, the caller decides whether to retry.
        this.logger.warn('ElevenLabs music generation rate-limited', { detail });
        throw new ProviderRateLimitError(
          'elevenlabs',
          `ElevenLabs music generation rate-limited: ${detail}`,
          parseRetryAfterMs(res.headers.get('retry-after'))
        );
      }
      this.logger.error('ElevenLabs music generation failed', { status: res.status, detail });
      throw new Error(`ElevenLabs music generation failed: ${res.status} ${detail}`);
    }

    const audio = Buffer.from(await res.arrayBuffer());
    // A truncated/empty 200 must fail here so the route refunds the reservation,
    // rather than settling the full charge and persisting a 0-byte file.
    if (audio.length === 0) {
      this.logger.error('ElevenLabs music generation returned an empty body', { status: res.status });
      throw new Error('ElevenLabs music generation returned no audio');
    }
    return { audio, contentType };
  }
}
