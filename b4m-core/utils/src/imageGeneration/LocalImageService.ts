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

/** Subset of `GET /sdapi/v1/options` we read - the currently loaded checkpoint. */
interface SdOptions {
  sd_model_checkpoint?: string;
}

const SD_MODELS_TIMEOUT_MS = 4000;
const OPTIONS_GET_TIMEOUT_MS = 30_000;

const DEFAULT_STEPS = 20;
const DEFAULT_DIMENSION = 512;
// CPU generation on a self-host box can take minutes per image; keep the client
// from aborting mid-render (Stable Diffusion at 512x512/20 steps is ~1-3 min on CPU).
const REQUEST_TIMEOUT_MS = 15 * 60_000;

// Loading a checkpoint on CPU can take several minutes; the options POST may block
// for that whole time, and we then poll until the server reports it loaded.
const DEFAULT_MODEL_LOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MODEL_LOAD_POLL_MS = 5000;

export interface LocalImageServiceOptions {
  /** Max time to wait for a checkpoint to finish loading (default 10 min). */
  modelLoadTimeoutMs?: number;
  /** Interval between load-status polls (default 5s). */
  modelLoadPollMs?: number;
}

/**
 * Image backend for a self-hosted Stable-Diffusion server exposing the
 * AUTOMATIC1111-compatible REST API (`POST /sdapi/v1/txt2img`). Gated by
 * `IMAGE_GEN_BASE_URL`; models are namespaced `local-image/<checkpoint>` and the
 * `local-image/` prefix is stripped before it becomes the `sd_model_checkpoint`
 * the server loads. Mirrors the local-text role that Ollama plays.
 *
 * Critically, SD.Next does NOT honor `override_settings.sd_model_checkpoint` as a
 * model-load trigger when no model is currently loaded (a fresh boot autoloads a
 * placeholder), so txt2img returns HTTP 200 with empty images. We therefore load
 * the target checkpoint explicitly via `POST /sdapi/v1/options` and poll
 * `GET /sdapi/v1/options` until it takes effect, THEN run txt2img (still passing
 * override_settings as belt-and-braces).
 */
export class LocalImageService extends AIImageService {
  private readonly baseUrl: string;
  private readonly modelLoadTimeoutMs: number;
  private readonly modelLoadPollMs: number;

  constructor(baseUrl: string, logger: Logger, options?: LocalImageServiceOptions) {
    // The base class stores an apiKey; local generation needs none, so the base
    // URL takes that slot and is also kept explicitly (trailing slash trimmed).
    super(baseUrl, logger);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.modelLoadTimeoutMs = options?.modelLoadTimeoutMs ?? DEFAULT_MODEL_LOAD_TIMEOUT_MS;
    this.modelLoadPollMs = options?.modelLoadPollMs ?? DEFAULT_MODEL_LOAD_POLL_MS;
  }

  async generate(prompt: string, options: AIImageGenerationOptions): Promise<string[]> {
    const { width, height } = this.resolveDimensions(options);
    const bareName = (options.model ?? '').replace(/^local-image\//, '');
    const { checkpoint, aliases } = await this.resolveCheckpoint(bareName);

    // Make sure the requested checkpoint is actually loaded before generating -
    // override_settings alone won't load it from a cold start (see class doc).
    await this.ensureCheckpointLoaded(checkpoint, aliases);

    const request: Txt2ImgRequest = {
      prompt,
      steps: options.steps ?? DEFAULT_STEPS,
      width,
      height,
      batch_size: options.n ?? 1,
      override_settings: { sd_model_checkpoint: checkpoint },
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
    // failure (e.g. the checkpoint never loaded), not a transport error - kept
    // outside the try so it isn't mislabeled.
    if (images.length === 0) {
      throw new Error('Local image server returned no images (the model may not have loaded)');
    }

    // The A1111 API returns bare base64; wrap as a data URI so downstream
    // download/upload treats it like the other providers' data-URI results.
    return images.map(b64 => `data:image/png;base64,${b64}`);
  }

  /**
   * Resolve the value to send as `sd_model_checkpoint` and the set of strings that
   * count as "this checkpoint is loaded". Stock A1111 matches on the full title
   * (`name [hash]`), so prefer the title from `/sdapi/v1/sd-models`; fall back to
   * the bare name if the lookup fails or finds no match. `aliases` holds both the
   * title and the bare model_name so a loaded-checkpoint match works either way.
   */
  private async resolveCheckpoint(bareName: string): Promise<{ checkpoint: string; aliases: string[] }> {
    try {
      const { data } = await axios.get<SdModel[]>(`${this.baseUrl}/sdapi/v1/sd-models`, {
        timeout: SD_MODELS_TIMEOUT_MS,
      });
      const match = (data ?? []).find(m => m.model_name === bareName);
      if (match) {
        return { checkpoint: match.title, aliases: [match.title, match.model_name] };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.debug(`[LocalImageService] sd-models lookup failed at ${this.baseUrl}: ${message}`);
    }
    return { checkpoint: bareName, aliases: [bareName] };
  }

  /**
   * Ensure `checkpoint` is the loaded model. If the server already reports a
   * matching checkpoint, return immediately; otherwise trigger a load via
   * `POST /sdapi/v1/options` and poll `GET /sdapi/v1/options` until it reflects
   * the target (bounded by `modelLoadTimeoutMs`). Throws a clear error on timeout
   * so a never-loaded model surfaces as an actionable failure, not an empty image.
   */
  private async ensureCheckpointLoaded(checkpoint: string, aliases: string[]): Promise<void> {
    if (this.checkpointMatches(await this.getLoadedCheckpoint(), aliases)) {
      return;
    }

    this.logger.info(`[LocalImageService] loading checkpoint "${checkpoint}" (this can take minutes on CPU)...`);
    await axios.post(
      `${this.baseUrl}/sdapi/v1/options`,
      { sd_model_checkpoint: checkpoint },
      // The POST can block for the whole load, so allow it the full budget.
      { timeout: this.modelLoadTimeoutMs }
    );

    const deadline = Date.now() + this.modelLoadTimeoutMs;
    while (Date.now() < deadline) {
      if (this.checkpointMatches(await this.getLoadedCheckpoint(), aliases)) {
        return;
      }
      await this.sleep(this.modelLoadPollMs);
    }
    throw new Error(`Local image model "${checkpoint}" did not finish loading in time`);
  }

  /** Current `sd_model_checkpoint` from `/sdapi/v1/options`, or undefined if unavailable. */
  private async getLoadedCheckpoint(): Promise<string | undefined> {
    try {
      const { data } = await axios.get<SdOptions>(`${this.baseUrl}/sdapi/v1/options`, {
        timeout: OPTIONS_GET_TIMEOUT_MS,
      });
      return data?.sd_model_checkpoint || undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.debug(`[LocalImageService] options lookup failed at ${this.baseUrl}: ${message}`);
      return undefined;
    }
  }

  /**
   * A loaded checkpoint counts as a match if it equals, or contains, any alias -
   * the bare `model_name` (e.g. `v1-5-pruned-emaonly`) is a substring of the full
   * title the server reports (`v1-5-pruned-emaonly.safetensors [hash]`).
   */
  private checkpointMatches(current: string | undefined, aliases: string[]): boolean {
    if (!current) return false;
    return aliases.some(a => !!a && (current === a || current.includes(a)));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
