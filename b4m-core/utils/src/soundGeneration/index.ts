import { SoundGenerationVendor } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { ElevenLabsSoundGenerator } from './ElevenLabsSoundGenerator';
import { SoundGenerator } from './types';

export * from './types';
export { ElevenLabsSoundGenerator } from './ElevenLabsSoundGenerator';
export type { ElevenLabsSoundGeneratorConfig } from './ElevenLabsSoundGenerator';

export interface SoundGeneratorOptions {
  /** Injectable HTTP client forwarded to the vendor implementation (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Resolves the {@link SoundGenerator} for a vendor. Adding a provider means
 * adding a case here plus a vendor entry in `supportedSoundGenerationVendor` --
 * callers depend only on the `SoundGenerator` interface (open/closed).
 */
export function aiSoundService(
  vendor: SoundGenerationVendor,
  apiKey: string,
  logger: Logger,
  options: SoundGeneratorOptions = {}
): SoundGenerator {
  switch (vendor) {
    case 'elevenlabs':
      return new ElevenLabsSoundGenerator({ apiKey, logger, fetchImpl: options.fetchImpl });
    default:
      throw new Error(`Unknown sound generation vendor: ${vendor}`);
  }
}
