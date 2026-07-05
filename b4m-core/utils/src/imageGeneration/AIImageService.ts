import { Logger } from '@bike4mind/observability';

export interface AIImageGenerationOptions {
  width?: number;
  height?: number;
  n?: number;
  user?: string;
  model?: string;
  safety_tolerance?: number;
  size?: '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792' | null;
  quality?: 'standard' | 'hd';
  style?: 'vivid' | 'natural';
  response_format?: 'url' | 'b64_json' | null;
  // BFL specific options
  output_format?: 'jpeg' | 'png' | null;
  prompt_upsampling?: boolean;
  steps?: number | null;
  seed?: number | null;
  guidance?: number | null;
  interval?: number | null;
  aspect_ratio?: string;
  raw?: boolean;
  image_prompt?: string | null;
  image_prompt_strength?: number;
  webhook_url?: string | null;
  webhook_secret?: string | null;
}

/**
 * Response type for image editing operations
 * Can be either a successful edit with a data URL, or a clarification request
 */
export type ImageEditResponse =
  | {
      type: 'success';
      dataUrl: string;
    }
  | {
      type: 'clarification';
      question: string;
      clarificationId: string;
      originalPrompt: string;
      originalImage: string;
      originalOptions: any;
    };

export abstract class AIImageService {
  constructor(
    protected apiKey: string,
    protected logger: Logger,
    protected imageProcessorLambdaName?: string
  ) {}

  abstract generate(prompt: string, options: AIImageGenerationOptions): Promise<string[]>;
  abstract edit(image: string, prompt: string, options: any): Promise<ImageEditResponse>;
  abstract variantions(image: Buffer, options: any): Promise<string[]>;
}
