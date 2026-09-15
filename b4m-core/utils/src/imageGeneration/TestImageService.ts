import { AIImageService, AIImageGenerationOptions, ImageEditOptions, ImageEditResponse } from './AIImageService';

export class TestImageService extends AIImageService {
  async generate(_prompt: string, _options: AIImageGenerationOptions): Promise<string[]> {
    throw new Error('Method not implemented.');
  }

  async edit(_image: string, _prompt: string, _options: ImageEditOptions): Promise<ImageEditResponse> {
    throw new Error('Method not implemented.');
  }
}
