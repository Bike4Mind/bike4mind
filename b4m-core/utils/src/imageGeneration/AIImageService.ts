import { Logger } from '@bike4mind/observability';
import {
  OpenAIImageQuality,
  OpenAIImageSize,
  type OpenAIImageBackground,
  type ImageOutputFormat,
} from '@bike4mind/common';

export interface AIImageGenerationOptions {
  width?: number;
  height?: number;
  n?: number;
  user?: string;
  model?: string;
  safety_tolerance?: number;
  size?: '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792' | null;
  // The full API-accepted set: DALL-E's 'standard'/'hd' plus the GPT-Image tiers.
  // Narrowing this to the DALL-E pair is what let callers silently drop a GPT-Image
  // tier they had already charged the user for.
  quality?: OpenAIImageQuality;
  style?: 'vivid' | 'natural';
  response_format?: 'url' | 'b64_json' | null;
  /** gpt-image only; other providers ignore it. See OpenAIImageService. */
  background?: OpenAIImageBackground | null;
  // BFL specific options
  output_format?: ImageOutputFormat | null;
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
 * Generation options plus an optional inpainting mask; each call site passes a
 * subset. `size` is widened to OpenAIImageSize (`string`) so callers can forward
 * provider-specific sizes; only OpenAIImageService.edit reads it.
 *
 * `n` rides along from AIImageGenerationOptions and is ignored: an ImageEditResponse carries one
 * dataUrl, so no implementation of edit() renders or returns more than one image. Start honoring
 * it only once this response type can carry several, or callers get billed for images they never
 * receive.
 */
export type ImageEditOptions = Omit<AIImageGenerationOptions, 'size'> & {
  mask?: string | null;
  size?: OpenAIImageSize;
  /**
   * gpt-image style-anchor images (URLs or data URLs), appended after the edit source in the
   * order given. Only OpenAIImageService.edit reads them; BFL and Gemini ignore them.
   */
  referenceImages?: string[];
};

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
      originalOptions: ImageEditOptions;
    };

export abstract class AIImageService {
  constructor(
    protected apiKey: string,
    protected logger: Logger,
    protected imageProcessorLambdaName?: string
  ) {}

  abstract generate(prompt: string, options: AIImageGenerationOptions): Promise<string[]>;
  abstract edit(image: string, prompt: string, options: ImageEditOptions): Promise<ImageEditResponse>;
}
