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
          'FLUX Kontext Pro - Advanced image-to-image transformation with high-quality output and versatile editing capabilities.',
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
          'FLUX Kontext Max - Premium image-to-image transformation with maximum quality and advanced editing capabilities.',
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
        description:
          'BlackForest Labs FLUX Kontext Max - Premium image-to-image transformation with maximum quality and capabilities',
        supportsSafetyTolerance: true,
        rank: 5,
      },
      // OpenAI models moved to OpenAI backend where they belong
    ];
  }
}
