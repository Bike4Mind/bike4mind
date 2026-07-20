import { IMessage, ModelBackend, type ModelInfo } from '@bike4mind/common';
import { ILogger, Logger } from '@bike4mind/observability';
import axios from 'axios';
import { CompletionInfo, ICompletionBackend, ICompletionOptions } from './backend';

/** One entry of the AUTOMATIC1111-compatible `GET /sdapi/v1/sd-models` response. */
interface SdModel {
  title: string;
  model_name: string;
}

/**
 * Backend for a self-hosted Stable-Diffusion server exposing the
 * AUTOMATIC1111-compatible REST API. It only enumerates the installed
 * checkpoints (`GET /sdapi/v1/sd-models`) as image `ModelInfo`s; the actual
 * generation goes through `LocalImageService`. Text completion is not
 * supported, mirroring `BFLBackend`. Gated by `IMAGE_GEN_BASE_URL`.
 */
export class LocalImageBackend implements ICompletionBackend {
  public currentModel: string = '';
  private readonly baseUrl: string;
  private readonly logger: ILogger;

  constructor(baseUrl: string, logger?: ILogger) {
    this.logger = logger ?? new Logger();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async complete(
    model: string,
    _messages: IMessage[],
    _options?: Partial<ICompletionOptions>,
    _onUpdate?: (texts: (string | null | undefined)[], info: CompletionInfo) => Promise<void>
  ): Promise<void> {
    this.currentModel = model;
    throw new Error('LocalImageBackend does not support text completion, only image generation');
  }

  pushToolMessages(
    _messages: IMessage[],
    _tool: { name: string; id: string; parameters: string },
    _result: string,
    _thinkingBlocks?: unknown[]
  ): void {
    throw new Error('LocalImageBackend does not support tool messages');
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    try {
      const { data } = await axios.get<SdModel[]>(`${this.baseUrl}/sdapi/v1/sd-models`, { timeout: 4000 });
      return (data ?? []).map(model => {
        // `local-image/<checkpoint>` ids are discovered at runtime and aren't in
        // the static ModelName union, so widen to string and cast the whole
        // record - the same pattern the Ollama backend uses for its dynamic ids.
        const id: string = `local-image/${model.model_name}`;
        return {
          id,
          type: 'image',
          name: model.model_name,
          backend: ModelBackend.LocalImage,
          contextWindow: 10000,
          max_tokens: 10000,
          supportsImageVariation: false,
          // Local generation is free; freeToRun suppresses the [UNPRICED_MODEL] alarm.
          pricing: {
            1: { input: 0, output: 0 },
          },
          freeToRun: true,
          rank: 1,
          logoFile: 'Ollama_Logo.svg',
          description: 'Runs locally on your own hardware via Stable Diffusion. No API key required.',
        } as ModelInfo;
      });
    } catch (error) {
      // Connection errors here usually mean the local image server is down or the
      // host is misconfigured; degrade to an empty list like the Ollama backend.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('[LocalImageBackend] Error fetching model info from local image server:', message);
      return [];
    }
  }
}
