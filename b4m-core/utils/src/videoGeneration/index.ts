import { VideoGenerationVendor } from '@bike4mind/common';
import { OpenAISoraVideoService } from './OpenAISoraVideoService';
import { Logger } from '@bike4mind/observability';

export { OpenAISoraVideoService };

export type { AIVideoGenerationOptions, VideoGenerationStatus } from './AIVideoService';
export { AIVideoService } from './AIVideoService';

type VideoServiceTypes = {
  openai: OpenAISoraVideoService;
};

/**
 * Factory function to create video generation service instances
 *
 * @param vendor - The video generation vendor (currently only 'openai')
 * @param apiKey - API key for the vendor
 * @param logger - Logger instance
 * @returns An instance of the appropriate video service
 */
export function aiVideoService<V extends VideoGenerationVendor>(
  vendor: V,
  apiKey: string,
  logger: Logger
): VideoServiceTypes[V] {
  switch (vendor) {
    case 'openai':
      return new OpenAISoraVideoService(apiKey, logger) as VideoServiceTypes[V];
    default:
      throw new Error(`Unknown AI video generator vendor: ${vendor}`);
  }
}
