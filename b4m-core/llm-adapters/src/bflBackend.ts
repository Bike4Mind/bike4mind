import { ImageModels, ModelBackend, ModelInfo } from '@bike4mind/common';
import { CompletionInfo, ICompletionBackend, ICompletionOptions } from './backend';
import { IMessage } from '@bike4mind/common';

export class BFLBackend implements ICompletionBackend {
  public currentModel: string = '';

  constructor(private apiKey: string) {}

  async complete(
    model: string,
    messages: IMessage[],
    options?: Partial<ICompletionOptions>,
    onUpdate?: (texts: (string | null | undefined)[], info: CompletionInfo) => Promise<void>
  ): Promise<void> {
    this.currentModel = model;
    throw new Error('BFLBackend does not support text completion, only image generation');
  }

  pushToolMessages(
    _messages: IMessage[],
    _tool: { name: string; id: string; parameters: string },
    _result: string,
    _thinkingBlocks?: unknown[]
  ) {
    throw new Error('BFLBackend does not support tool messages');
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return [
      // BFL Models first - modern, state-of-the-art image generation
      {
        id: ImageModels.FLUX_PRO_1_1,
        type: 'image',
        name: 'FLUX Pro 1.1',
        backend: ModelBackend.BFL,
        contextWindow: 10000,
        supportsImageVariation: true,
        max_tokens: 10000,
        pricing: {
          1: { input: 400, output: 400 }, // $0.04 per image
        },
        description:
          'FLUX Pro 1.1 - Professional quality image generation with strong prompt adherence and fast turnaround.',
        supportsSafetyTolerance: true,
        rank: 1,
      },
      // Deprecated: FLUX_PRO - kept for backwards compatibility with existing data
      {
        id: ImageModels.FLUX_PRO,
        type: 'image',
        name: 'FLUX Pro (Legacy)',
        backend: ModelBackend.BFL,
        contextWindow: 10000,
        supportsImageVariation: true,
        max_tokens: 10000,
        pricing: {
          1: { input: 500, output: 500 }, // $0.05 per image
        },
        description: 'FLUX Pro - Legacy model. Please use FLUX Pro 1.1 for new generations.',
        supportsSafetyTolerance: true,
        deprecationDate: '2025-12-01',
        rank: 99, // Push to bottom of list
      },
      {
        id: ImageModels.FLUX_PRO_ULTRA,
        type: 'image',
        name: 'FLUX Pro Ultra',
        backend: ModelBackend.BFL,
        contextWindow: 10000,
        supportsImageVariation: true,
        max_tokens: 10000,
        pricing: {
          1: { input: 550, output: 550 }, // $0.055 per image
        },
        description:
          'FLUX Pro Ultra - Premium image generation with enhanced capabilities and exceptional quality output.',
        supportsSafetyTolerance: true,
        rank: 2,
      },
      {
        id: ImageModels.FLUX_PRO_FILL,
        type: 'image',
        name: 'FLUX Pro Fill',
        private: true,
        backend: ModelBackend.BFL,
        supportsImageVariation: false,
        contextWindow: 10000,
        max_tokens: 10000,
        pricing: {
          1000: { input: 0, output: 0 },
        },
        description: 'FLUX Pro Fill - Specialized model for image inpainting and completion tasks with precise detail.',
        supportsSafetyTolerance: true,
        rank: 3,
      },
      {
        id: ImageModels.FLUX_KONTEXT_PRO,
        type: 'image',
        name: 'FLUX Kontext Pro',
        backend: ModelBackend.BFL,
        supportsImageVariation: true,
        contextWindow: 10000,
        max_tokens: 10000,
        pricing: {
          1: { input: 350, output: 350 }, // $0.035 per transformation
        },
        description:
          'FLUX Kontext Pro - Advanced image-to-image transformation with high-quality output and versatile editing capabilities.',
        supportsSafetyTolerance: true,
        rank: 4,
      },
      {
        id: ImageModels.FLUX_KONTEXT_MAX,
        type: 'image',
        name: 'FLUX Kontext Max',
        backend: ModelBackend.BFL,
        supportsImageVariation: true,
        contextWindow: 10000,
        max_tokens: 10000,
        pricing: {
          1: { input: 450, output: 450 }, // $0.045 per transformation
        },
        description: 'FLUX Kontext Max - Premium image-to-image transformation with maximum quality and capabilities.',
        supportsSafetyTolerance: true,
        rank: 5,
      },
      // FLUX.2 family. The endpoints are discovered from BFL's OpenAPI, but presentation and
      // price are curated here: discovery supplies neither, so an endpoint without an entry is
      // introduced under its slug, left auto-disabled and reported in the discovery run - it
      // never reaches the picker. Prices are BFL's published first-megapixel rates
      // (https://bfl.ai/pricing); the cost path bills a flat per-image figure, so a larger
      // output under-bills. Keep the two preview entries' prices equal to the pinned siblings
      // they mirror, since BFL publishes no rate for a preview.
      {
        id: ImageModels.FLUX_2_MAX,
        type: 'image',
        name: 'FLUX.2 Max',
        backend: ModelBackend.BFL,
        contextWindow: 10000,
        supportsImageVariation: true,
        max_tokens: 10000,
        pricing: {
          1: { input: 700, output: 700 }, // $0.07 per image
        },
        description:
          'FLUX.2 Max - Flagship FLUX.2 generation and editing with the highest output quality and up to eight reference images.',
        supportsSafetyTolerance: true,
        rank: 6,
      },
      {
        id: ImageModels.FLUX_2_PRO,
        type: 'image',
        name: 'FLUX.2 Pro',
        backend: ModelBackend.BFL,
        contextWindow: 10000,
        supportsImageVariation: true,
        max_tokens: 10000,
        pricing: {
          1: { input: 300, output: 300 }, // $0.03 per image
        },
        description:
          'FLUX.2 Pro - Production FLUX.2 generation and editing with strong prompt adherence and up to eight reference images.',
        supportsSafetyTolerance: true,
        rank: 7,
      },
      {
        id: ImageModels.FLUX_2_PRO_PREVIEW,
        type: 'image',
        name: 'FLUX.2 Pro (Preview)',
        backend: ModelBackend.BFL,
        contextWindow: 10000,
        supportsImageVariation: true,
        max_tokens: 10000,
        pricing: {
          1: { input: 300, output: 300 }, // $0.03 per image: BFL publishes no preview rate, billed at FLUX.2 Pro's
        },
        description:
          'FLUX.2 Pro (Preview) - Preview build of FLUX.2 Pro, sharing its generation and editing request contract.',
        supportsSafetyTolerance: true,
        rank: 8,
      },
      {
        id: ImageModels.FLUX_2_FLEX,
        type: 'image',
        name: 'FLUX.2 Flex',
        backend: ModelBackend.BFL,
        contextWindow: 10000,
        supportsImageVariation: true,
        max_tokens: 10000,
        pricing: {
          1: { input: 500, output: 500 }, // $0.05 per image
        },
        description:
          'FLUX.2 Flex - FLUX.2 generation and editing with strong detail preservation and up to eight reference images.',
        supportsSafetyTolerance: true,
        rank: 9,
      },
      {
        id: ImageModels.FLUX_2_KLEIN_9B,
        type: 'image',
        name: 'FLUX.2 Klein 9B',
        backend: ModelBackend.BFL,
        contextWindow: 10000,
        supportsImageVariation: true,
        max_tokens: 10000,
        pricing: {
          1: { input: 150, output: 150 }, // $0.015 per image
        },
        description:
          'FLUX.2 Klein 9B - Compact 9B FLUX.2 model for fast, low-cost generation and editing with up to four reference images.',
        supportsSafetyTolerance: true,
        rank: 10,
      },
      {
        id: ImageModels.FLUX_2_KLEIN_9B_PREVIEW,
        type: 'image',
        name: 'FLUX.2 Klein 9B (Preview)',
        backend: ModelBackend.BFL,
        contextWindow: 10000,
        supportsImageVariation: true,
        max_tokens: 10000,
        pricing: {
          1: { input: 150, output: 150 }, // $0.015 per image: BFL publishes no preview rate, billed at FLUX.2 Klein 9B's
        },
        description:
          'FLUX.2 Klein 9B (Preview) - Preview build of FLUX.2 Klein 9B, sharing its generation and editing request contract.',
        supportsSafetyTolerance: true,
        rank: 11,
      },
      {
        id: ImageModels.FLUX_2_KLEIN_4B,
        type: 'image',
        name: 'FLUX.2 Klein 4B',
        backend: ModelBackend.BFL,
        contextWindow: 10000,
        supportsImageVariation: true,
        max_tokens: 10000,
        pricing: {
          1: { input: 140, output: 140 }, // $0.014 per image
        },
        description:
          'FLUX.2 Klein 4B - Smallest FLUX.2 model, for the fastest and cheapest generation and editing at 4B parameters.',
        supportsSafetyTolerance: true,
        rank: 12,
      },
      // OpenAI models moved to OpenAI backend where they belong
    ];
  }
}
