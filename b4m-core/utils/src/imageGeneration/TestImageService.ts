import { AIImageService, AIImageGenerationOptions, ImageEditResponse } from './AIImageService';

export class TestImageService extends AIImageService {
  async generate(prompt: string, options: AIImageGenerationOptions): Promise<string[]> {
    throw new Error('Method not implemented.');
  }

  async edit(image: string, prompt: string, options: any): Promise<ImageEditResponse> {
    throw new Error('Method not implemented.');
  }

  async variantions(image: Buffer, options: any): Promise<string[]> {
    throw new Error('Method not implemented.');
  }
}
