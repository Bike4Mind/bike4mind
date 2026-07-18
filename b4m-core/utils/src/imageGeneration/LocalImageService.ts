import { Logger } from '@bike4mind/observability';
import axios from 'axios';
import { AIImageService, AIImageGenerationOptions, ImageEditResponse } from './AIImageService';

/** Request body for the AUTOMATIC1111-compatible `POST /sdapi/v1/txt2img` endpoint. */
interface Txt2ImgRequest {
  prompt: string;
  steps: number;
  width: number;
  height: number;
  batch_size: number;
  override_settings: {
    sd_model_checkpoint: string;
  };
}

/** Response shape for `POST /sdapi/v1/txt2img`. `images` are bare base64 PNGs (no data-URI prefix). */
interface Txt2ImgResponse {
  images?: string[];
}

/** One entry of the `GET /sdapi/v1/sd-models` response. `title` is `name [hash]`. */
interface SdModel {
  title: string;
  model_name: string;
}

const SD_MODELS_TIMEOUT_MS = 4000;

const DEFAULT_STEPS = 20;
const DEFAULT_DIMENSION = 512;
// CPU generation on a self-host box can take minutes per image; keep the client
// from aborting mid-render (Stable Diffusion at 512x512/20 steps is ~1-3 min on CPU).
const REQUEST_TIMEOUT_MS = 15 * 60_000;

/**
 * Image backend for a self-hosted Stable-Diffusion server exposing the
 * AUTOMATIC1111-compatible REST API (`POST /sdapi/v1/txt2img`). Gated by
 * `IMAGE_GEN_BASE_URL`; models are namespaced `local-image/<checkpoint>` and the
 * `local-image/` prefix is stripped before it becomes the `sd_model_checkpoint`
 * the server loads. Mirrors the local-text role that Ollama plays.
 */
export class LocalImageService extends AIImageService {
  private readonly baseUrl: string;

  constructor(baseUrl: string, logger: Logger) {
    // The base class stores an apiKey; local generation needs none, so the base
    // URL takes that slot and is also kept explicitly (trailing slash trimmed).
    super(baseUrl, logger);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async generate(prompt: string, options: AIImageGenerationOptions): Promise<string[]> {
    const { width, height } = this.resolveDimensions(options);
    const bareName = (options.model ?? '').replace(/^local-image\//, '');
    const request: Txt2ImgRequest = {
      prompt,
      steps: options.steps ?? DEFAULT_STEPS,
      width,
      height,
      batch_size: options.n ?? 1,
      override_settings: {
        sd_model_checkpoint: await this.resolveCheckpointName(bareName),
      },
    };

    let images: string[] = [];
    try {
      const { data } = await axios.post<Txt2ImgResponse>(`${this.baseUrl}/sdapi/v1/txt2img`, request, {
        timeout: REQUEST_TIMEOUT_MS,
      });
      images = data.images ?? [];
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[LocalImageService] txt2img failed at ${this.baseUrl}: ${message}`);
      throw error instanceof Error ? error : new Error('Local image generation error: Unknown error');
    }

    // A successful HTTP call that returns no images is a server-side generation
    // failure, not a transport error - kept outside the try so it isn't mislabeled.
    if (images.length === 0) {
      throw new Error('Local image server returned no images');
    }

    // The A1111 API returns bare base64; wrap as a data URI so downstream
    // download/upload treats it like the other providers' data-URI results.
    return images.map(b64 => `data:image/png;base64,${b64}`);
  }

  /**
   * Resolve the value to send as `sd_model_checkpoint`. Stock A1111 commonly
   * matches on the full title (`name [hash]`) rather than the bare model_name,
   * so look the checkpoint up in `/sdapi/v1/sd-models` and prefer its title.
   * Falls back to the bare name if the lookup fails or finds no match (SD.Next
   * accepts the bare name), so a slow/absent models endpoint never blocks a render.
   */
  private async resolveCheckpointName(bareName: string): Promise<string> {
    try {
      const { data } = await axios.get<SdModel[]>(`${this.baseUrl}/sdapi/v1/sd-models`, {
        timeout: SD_MODELS_TIMEOUT_MS,
      });
      const match = (data ?? []).find(m => m.model_name === bareName);
      return match?.title ?? bareName;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.debug(`[LocalImageService] sd-models lookup failed at ${this.baseUrl}: ${message}`);
      return bareName;
    }
  }

  /**
   * Prefer explicit width/height, then a `WxH` size string, else a square
   * default. The A1111 API takes discrete width/height, not the size enum.
   */
  private resolveDimensions(options: AIImageGenerationOptions): { width: number; height: number } {
    if (options.width && options.height) {
      return { width: options.width, height: options.height };
    }
    if (typeof options.size === 'string') {
      const [w, h] = options.size.split('x').map(Number);
      if (w && h) {
        return { width: w, height: h };
      }
    }
    return { width: DEFAULT_DIMENSION, height: DEFAULT_DIMENSION };
  }

  async edit(_image: string, _prompt: string, _options: unknown): Promise<ImageEditResponse> {
    throw new Error('LocalImageService does not support image editing');
  }

  async variantions(_image: Buffer, _options: unknown): Promise<string[]> {
    throw new Error('LocalImageService does not support image variations');
  }
}
