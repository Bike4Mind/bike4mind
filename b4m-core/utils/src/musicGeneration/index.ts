import { MusicGenerationVendor } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { ElevenLabsMusicGenerator } from './ElevenLabsMusicGenerator';
import { MusicGenerator } from './types';

export * from './types';
export { ElevenLabsMusicGenerator, MUSIC_GENERATION_TIMEOUT_MS } from './ElevenLabsMusicGenerator';
export type { ElevenLabsMusicGeneratorConfig } from './ElevenLabsMusicGenerator';

export interface MusicGeneratorOptions {
  /** Injectable HTTP client forwarded to the vendor implementation (tests). */
  fetchImpl?: typeof fetch;
  /** Provider-fetch deadline override, e.g. what is left of a request budget after waiting for capacity. */
  timeoutMs?: number;
}

/**
 * Resolves the {@link MusicGenerator} for a vendor. Adding a provider means
 * adding a case here plus a vendor entry in `supportedMusicGenerationVendor` --
 * callers depend only on the `MusicGenerator` interface (open/closed).
 */
export function aiMusicService(
  vendor: MusicGenerationVendor,
  apiKey: string,
  logger: Logger,
  options: MusicGeneratorOptions = {}
): MusicGenerator {
  switch (vendor) {
    case 'elevenlabs':
      return new ElevenLabsMusicGenerator({
        apiKey,
        logger,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
    default:
      throw new Error(`Unknown music generation vendor: ${vendor}`);
  }
}
