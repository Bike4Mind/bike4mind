import { ImageGenerationVendor } from '@bike4mind/common';
import { OpenAIImageService } from './OpenAIImageService';
import { TestImageService } from './TestImageService';
import { BFLImageService } from './BFLImageService';
import { XAIImageService } from './XAIImageService';
import { GeminiImageService } from './GeminiImageService';
import { Logger } from '@bike4mind/observability';

// Export the individual classes
export { OpenAIImageService, TestImageService, BFLImageService, XAIImageService, GeminiImageService };

// Export types
export type { ImageEditResponse } from './AIImageService';

type ImageServiceTypes = {
  openai: OpenAIImageService;
  test: TestImageService;
  bfl: BFLImageService;
  xai: XAIImageService;
  gemini: GeminiImageService;
};

/**
 * This factory function will create instances of the appropriate class based on the vendor name:
 * @param imageProcessorLambdaName - Optional Lambda function name for image processing (from SST Resource.ImageProcessor.name)
 */
export function aiImageService<V extends keyof ImageServiceTypes & ImageGenerationVendor>(
  vendor: V,
  apiKey: string,
  logger: Logger,
  imageProcessorLambdaName?: string
): ImageServiceTypes[V] {
  switch (vendor) {
    case 'openai':
      return new OpenAIImageService(apiKey, logger, imageProcessorLambdaName) as ImageServiceTypes[V];
    case 'test':
      // TestImageService inherits from AIImageService, so it accepts imageProcessorLambdaName
      return new TestImageService(apiKey, logger, imageProcessorLambdaName) as ImageServiceTypes[V];
    case 'bfl':
      // BFLImageService has its own constructor that only accepts (apiKey, logger)
      return new BFLImageService(apiKey, logger) as ImageServiceTypes[V];
    case 'xai':
      // XAIImageService inherits from AIImageService, so it accepts imageProcessorLambdaName
      return new XAIImageService(apiKey, logger, imageProcessorLambdaName) as ImageServiceTypes[V];
    case 'gemini':
      // GeminiImageService has its own constructor that only accepts (apiKey, logger)
      return new GeminiImageService(apiKey, logger) as ImageServiceTypes[V];
    default:
      throw new Error(`Unknown AI image generator vendor: ${vendor}`);
  }
}
