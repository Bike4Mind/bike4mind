import { AIImageService, AIImageGenerationOptions, ImageEditResponse } from './AIImageService';
import { GoogleGenAI, type GenerateImagesConfig } from '@google/genai';
import { Logger } from '@bike4mind/observability';
import { ImageModels } from '@bike4mind/common';
import { v4 as uuidv4 } from 'uuid';

export class GeminiImageService extends AIImageService {
  private genAI: GoogleGenAI;

  constructor(apiKey: string, logger: Logger, imageProcessorLambdaName?: string) {
    super(apiKey, logger, imageProcessorLambdaName);
    this.genAI = new GoogleGenAI({ apiKey });
  }

  async generate(prompt: string, options: AIImageGenerationOptions): Promise<string[]> {
    this.logger.log('Generating image with Gemini... with these params: ', options);

    try {
      const n = options.n || 1;
      const imagePromises: Promise<string>[] = [];

      for (let i = 0; i < n; i++) {
        imagePromises.push(this.generateSingleImage(prompt, options));
      }

      const imageUrls = await Promise.all(imagePromises);
      this.logger.log(`Gemini generated ${imageUrls.length} image(s) successfully`);
      return imageUrls;
    } catch (error) {
      this.logger.error('Gemini image generation failed:', error);

      if (error instanceof Error) {
        // Provide helpful error messages for common Gemini issues
        if (error.message.includes('API_KEY') || error.message.includes('401')) {
          throw new Error(
            `Gemini image generation failed: Invalid API key or unauthorized access. Please check your Gemini API key. Original error: ${error.message}`
          );
        }
        if (error.message.includes('RATE_LIMIT') || error.message.includes('quota') || error.message.includes('429')) {
          throw new Error(
            `Gemini image generation failed: Rate limit or quota exceeded. Please try again later. Original error: ${error.message}`
          );
        }
        if (error.message.includes('SAFETY') || error.message.includes('blocked')) {
          throw new Error(
            `Gemini image generation failed: Content was blocked by safety filters. Please try adjusting your prompt. Original error: ${error.message}`
          );
        }
        throw new Error(`Gemini image generation failed: ${error.message}`);
      }

      throw new Error('Gemini image generation failed with unknown error');
    }
  }

  private async generateSingleImage(prompt: string, options: AIImageGenerationOptions): Promise<string> {
    try {
      const config = this.buildGenerationConfig(options);
      const model = (options.model as ImageModels) || ImageModels.GEMINI_2_5_FLASH_IMAGE;

      this.logger.log('[DEBUG] Gemini generation request:', {
        model,
        prompt: prompt.substring(0, 100) + '...',
        config,
      });

      let dataUrl: string | null = null;

      try {
        const response = await this.genAI.models.generateImages({
          model,
          prompt,
          config,
        });

        dataUrl = this.extractImageFromGenerateImages(response, options);
      } catch (error) {
        if (!this.shouldFallbackToGenerateContent(error)) {
          throw error;
        }

        this.logger.warn(
          `[DEBUG] Falling back to generateContent for Gemini image generation due to unsupported generateImages call. ${error}`
        );
        dataUrl = await this.generateImageViaContent(prompt, model);
      }

      if (!dataUrl) {
        throw new Error('No image data returned from Gemini');
      }

      this.logger.log('[DEBUG] Successfully generated Gemini image');
      return dataUrl;
    } catch (error) {
      this.logger.error('[DEBUG] Error generating single Gemini image:', error);
      throw error;
    }
  }

  private extractImageFromGenerateImages(response: any, options: AIImageGenerationOptions): string | null {
    if (!response?.generatedImages || response.generatedImages.length === 0) {
      return null;
    }

    const generatedImage = response.generatedImages[0];
    if (!generatedImage?.image?.imageBytes) {
      this.logger.error('[DEBUG] No image bytes in Gemini generateImages response.', response);
      return null;
    }

    const mimeType = generatedImage.image.mimeType ?? this.resolveMimeType(options.output_format);
    return `data:${mimeType};base64,${generatedImage.image.imageBytes}`;
  }

  private shouldFallbackToGenerateContent(error: unknown): boolean {
    const matchText = (text: string) =>
      text.includes('NOT_FOUND') ||
      text.includes('not supported for predict') ||
      text.includes('generateImages is not supported');

    if (error instanceof Error) {
      const message = `${error.message} ${error.stack ?? ''}`;
      if (matchText(message)) return true;
    }

    if (typeof error === 'object' && error !== null) {
      const maybeError = error as { error?: { code?: number; status?: string; message?: string } };
      const innerMessage = maybeError.error?.message;
      const status = maybeError.error?.status;
      if ((maybeError.error?.code === 404 || status === 'NOT_FOUND') && innerMessage) {
        return true;
      }
      if (innerMessage && matchText(innerMessage)) {
        return true;
      }
    }

    return false;
  }

  private async generateImageViaContent(
    prompt: string,
    model: ImageModels = ImageModels.GEMINI_2_5_FLASH_IMAGE
  ): Promise<string> {
    const response = await this.genAI.models.generateContent({
      model,
      contents: [{ text: prompt }],
      // Without IMAGE modality, Gemini treats the prompt as chat and replies with
      // text ("Would you like me to generate an image...") instead of image data.
      config: { responseModalities: ['IMAGE', 'TEXT'] },
    });

    if (!response.candidates || response.candidates.length === 0) {
      throw new Error('No candidates returned from Gemini');
    }

    const candidate = response.candidates[0];
    if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
      throw new Error('No content parts in Gemini response');
    }

    const textMessage = this.extractTextFromParts(candidate.content.parts);
    const imagePart = candidate.content.parts.find((part: any) => part.inlineData);
    if (!imagePart?.inlineData?.data) {
      this.logger.error('[DEBUG] No image inline data in Gemini generateContent response.', candidate.content.parts);
      if (textMessage) {
        throw new Error(textMessage);
      }
      throw new Error('No image data in Gemini response');
    }

    const mimeType = imagePart.inlineData.mimeType ?? 'image/png';
    return `data:${mimeType};base64,${imagePart.inlineData.data}`;
  }

  private extractTextFromParts(parts: any[]): string | null {
    if (!Array.isArray(parts)) {
      return null;
    }

    const texts = parts.map(part => (typeof part?.text === 'string' ? part.text.trim() : '')).filter(Boolean);

    if (texts.length === 0) {
      return null;
    }

    const message = texts.join(' ').replace(/\s+/g, ' ').trim();
    const MAX_LENGTH = 500;
    return message.length > MAX_LENGTH ? `${message.slice(0, MAX_LENGTH)}…` : message;
  }

  private buildGenerationConfig(options: AIImageGenerationOptions): GenerateImagesConfig {
    const config: GenerateImagesConfig = {
      numberOfImages: 1,
    };

    const aspectRatio = this.resolveAspectRatio(options);
    if (aspectRatio) {
      config.aspectRatio = aspectRatio;
    }

    if (options.guidance !== null && options.guidance !== undefined) {
      config.guidanceScale = options.guidance;
    }

    if (options.prompt_upsampling !== undefined) {
      config.enhancePrompt = options.prompt_upsampling;
    }

    if (options.seed !== null && options.seed !== undefined) {
      config.seed = options.seed;
    }

    const outputMimeType = this.resolveMimeType(options.output_format);
    if (outputMimeType) {
      config.outputMimeType = outputMimeType;
    }

    return config;
  }

  private resolveAspectRatio(options: AIImageGenerationOptions): string | undefined {
    if (options.aspect_ratio) {
      return options.aspect_ratio;
    }

    const parseSize = (size?: string | null) => {
      if (!size) return undefined;
      const [width, height] = size.split('x').map(value => Number.parseInt(value, 10));
      return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
    };

    const dimensions =
      (options.width && options.height ? { width: options.width, height: options.height } : undefined) ??
      parseSize(options.size);

    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
      return undefined;
    }

    const gcd = (a: number, b: number): number => {
      while (b !== 0) {
        const temp = b;
        b = a % b;
        a = temp;
      }
      return a;
    };

    const divisor = gcd(dimensions.width, dimensions.height);
    if (divisor === 0) {
      return undefined;
    }
    const widthRatio = Math.round(dimensions.width / divisor);
    const heightRatio = Math.round(dimensions.height / divisor);

    return `${widthRatio}:${heightRatio}`;
  }

  private resolveMimeType(format?: 'jpeg' | 'png' | null): string {
    if (format === 'jpeg') {
      return 'image/jpeg';
    }
    // Default to PNG as Gemini currently returns PNG data when unspecified.
    return 'image/png';
  }

  async edit(image: string, prompt: string, options: any): Promise<ImageEditResponse> {
    this.logger.log('Editing image with Gemini...');

    try {
      let imageData: { mimeType: string; data: string };
      if (image.startsWith('data:')) {
        const matches = image.match(/^data:([^;]+);base64,(.+)$/);
        if (!matches) {
          throw new Error('Invalid data URL format');
        }
        imageData = {
          mimeType: matches[1],
          data: matches[2],
        };
      } else {
        // Assume it's base64 data
        imageData = {
          mimeType: 'image/png',
          data: image,
        };
      }

      const contents = [
        { text: prompt },
        {
          inlineData: {
            mimeType: imageData.mimeType,
            data: imageData.data,
          },
        },
      ];

      const model = (options?.model as ImageModels) || ImageModels.GEMINI_2_5_FLASH_IMAGE;
      this.logger.log('[DEBUG] Gemini edit request:', {
        model,
        prompt: prompt.substring(0, 100) + '...',
        hasImage: true,
      });

      const response = await this.genAI.models.generateContent({
        model,
        contents,
        // Request IMAGE output so Gemini edits the image rather than replying with chat text.
        config: { responseModalities: ['IMAGE', 'TEXT'] },
      });

      if (!response.candidates || response.candidates.length === 0) {
        throw new Error('No candidates returned from Gemini');
      }

      const candidate = response.candidates[0];
      if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
        throw new Error('No content parts in Gemini response');
      }

      const textMessage = this.extractTextFromParts(candidate.content.parts);
      const imagePart = candidate.content.parts.find((part: any) => part.inlineData);

      // Check if Gemini is asking for clarification instead of generating an image
      if (!imagePart || !imagePart.inlineData) {
        this.logger.warn('[DEBUG] No image data in edit response - Gemini may be requesting clarification');

        if (textMessage) {
          // Return a clarification request instead of throwing an error
          const clarificationId = uuidv4();
          this.logger.log('[DEBUG] Returning clarification request:', {
            clarificationId,
            questionPreview: textMessage.substring(0, 100) + '...',
          });

          return {
            type: 'clarification',
            question: textMessage,
            clarificationId,
            originalPrompt: prompt,
            originalImage: image,
            originalOptions: options,
          };
        }

        throw new Error('No image data in Gemini response');
      }

      const { mimeType, data } = imagePart.inlineData;
      const dataUrl = `data:${mimeType};base64,${data}`;

      this.logger.log('Gemini image editing completed successfully');
      return { type: 'success', dataUrl };
    } catch (error) {
      this.logger.error('Gemini image editing failed:', error);

      if (error instanceof Error) {
        throw new Error(`Gemini image editing failed: ${error.message}`);
      }

      throw new Error('Gemini image editing failed with unknown error');
    }
  }

  async variantions(_image: Buffer, _options: any): Promise<string[]> {
    throw new Error(
      'Image variations are not directly supported by Gemini. Use edit() with variation prompts instead.'
    );
  }
}
