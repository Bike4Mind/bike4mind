import { Logger } from '@bike4mind/observability';
import { AIImageService, ImageEditOptions, ImageEditResponse } from './AIImageService';
import axios from 'axios';
import {
  ImageModels,
  BFL_SAFETY_TOLERANCE,
  type BFLImageModel,
  isBflUltraImageModel,
  isFlux2ImageModel,
  isFlux3ImageModel,
  takesBflInputImageList,
  getMaxReferenceImages,
  supportsBflOutputFormat,
  supportsBflSeed,
  supportsPromptUpsampling,
  toNonWebpOutputFormat,
  formatBflEditRegionsPrompt,
} from '@bike4mind/common';
import { redactErrorForLog } from './redactErrorForLog';
import {
  ExpectedImageGenerationError,
  ImageModerationBlockedError,
  ImageProviderUnavailableError,
} from './imageGenerationErrors';

/** Transient network failures reaching BFL: no response, so nothing about the request itself was wrong. */
const UNREACHABLE_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNABORTED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
]);

/** BFL statuses meaning its moderation refused the prompt (Request) or the rendered image (Content). */
const MODERATED_STATUSES = new Set(['Request Moderated', 'Content Moderated']);

/** FLUX.2 takes its source and reference images as input_image, input_image_2, ... in order. */
const flux2InputImageFields = (images: string[]): Record<string, string> =>
  Object.fromEntries(images.map((image, index) => [index === 0 ? 'input_image' : `input_image_${index + 1}`, image]));

/** FLUX.2 (except flex) inverts upsampling into `disable_pup`; other models that support it take `prompt_upsampling`. */
const promptUpsamplingBodyFields = (model: string, promptUpsampling: boolean) =>
  !supportsPromptUpsampling(model)
    ? {}
    : isFlux2ImageModel(model) && model !== ImageModels.FLUX_2_FLEX
      ? { disable_pup: !promptUpsampling }
      : { prompt_upsampling: promptUpsampling };

/** Log-safe copy of a request body: base64 image payloads (image, mask, input_image*) become a length marker. */
const redactInputImages = (body: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      typeof value === 'string' && /^(image|mask|input_image(_\d+)?)$/.test(key)
        ? `[BASE64_DATA_${value.length}_CHARS]`
        : value,
    ])
  );

/** BFL statuses meaning the task is still running. FLUX 3 reports Reasoning and Generating before Ready. */
const IN_PROGRESS_STATUSES = new Set(['Pending', 'Reasoning', 'Generating']);

/** Request-body keys holding image data, redacted before the body is logged. */
const IMAGE_DATA_KEY = /^(?:image_prompt|input_image(?:_\d+)?|images)$/;

export type BflGenerateOptions = {
  n?: number;
  user?: string;
  model?: BFLImageModel;
  safety_tolerance?: number;
  prompt_upsampling?: boolean;
  seed?: number | null;
  output_format?: 'jpeg' | 'png' | null;
  width?: number;
  height?: number;
  aspect_ratio?: string;
  image_prompt?: string;
  reference_images?: string[];
  [key: string]: unknown;
};

export type BflTransformOptions = {
  model?: ImageModels.FLUX_KONTEXT_PRO | ImageModels.FLUX_KONTEXT_MAX;
  safety_tolerance?: number;
  prompt_upsampling?: boolean;
  seed?: number | null;
  output_format?: 'jpeg' | 'png';
  aspect_ratio?: string;
  [key: string]: unknown;
};

/** One BFL task request: the model's endpoint and the body to post to it. */
export type BflTaskRequest = { model: string; body: Record<string, unknown> };

/** A submitted BFL task. `pollingUrl` is where BFL serves its result (it may be a regional host). */
export type BflTask = { id: string; pollingUrl: string };

/** One reading of a task. `pending` covers both BFL's in-progress statuses and any status it has not documented. */
export type BflTaskStatus =
  | { state: 'pending'; status: unknown }
  | { state: 'ready'; sampleUrl: string }
  | { state: 'moderated'; status: string }
  | { state: 'failed'; message: string };

export class BFLImageService extends AIImageService {
  private baseUrl = 'https://api.bfl.ai/v1';

  /** Strip null and undefined values from an object to avoid 422 rejections from BFL API */
  private stripNullFields<T extends Record<string, unknown>>(obj: T): Partial<T> {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null)) as Partial<T>;
  }

  /**
   * Hard cap on safety_tolerance: this is the last mile before the BFL API, so
   * it holds regardless of which caller or schema produced the value. Not
   * configurable by design - raising it is a legal-exposure decision, not a
   * runtime option.
   */
  private clampSafetyTolerance(value: number): number {
    if (!Number.isFinite(value)) {
      return BFL_SAFETY_TOLERANCE.DEFAULT;
    }
    // BFL documents safety_tolerance as an integer; FLUX 3 rejects a fractional one with a 422.
    const rounded = Math.round(value);
    if (rounded !== value) {
      Logger.globalInstance.debug(`[BFLImageService] safety_tolerance ${value} rounded to ${rounded}`);
    }
    const clamped = Math.min(Math.max(rounded, BFL_SAFETY_TOLERANCE.MIN), BFL_SAFETY_TOLERANCE.MAX);
    if (clamped !== rounded) {
      Logger.globalInstance.warn(
        `[BFLImageService] safety_tolerance ${rounded} clamped to ${clamped} (hard cap ${BFL_SAFETY_TOLERANCE.MAX})`
      );
    }
    return clamped;
  }

  constructor(apiKey: string, logger: Logger, imageProcessorLambdaName?: string) {
    super(apiKey, logger, imageProcessorLambdaName);
  }

  /**
   * The body for one image. Throws when the options ask for something the model cannot take (too many references).
   * Shared by the chat path (generate) and the image job adapter, which submits and polls in separate steps.
   */
  buildGenerateRequest(
    prompt: string,
    {
      n: _n,
      user = 'user',
      model = ImageModels.FLUX_PRO_1_1,
      safety_tolerance = BFL_SAFETY_TOLERANCE.DEFAULT,
      prompt_upsampling = false,
      seed = null,
      output_format = 'png',
      width = 1024,
      height = 768,
      aspect_ratio = '16:9',
      image_prompt,
      reference_images = [],
      ...modelSpecificOptions
    }: BflGenerateOptions
  ): BflTaskRequest {
    const referenceImages = [...new Set([...(image_prompt ? [image_prompt] : []), ...reference_images])];
    if (reference_images.length && !takesBflInputImageList(model)) {
      throw new Error(`Model ${model} does not support multiple reference images`);
    }
    if (takesBflInputImageList(model) && referenceImages.length > getMaxReferenceImages(model)) {
      throw new Error(`Model ${model} accepts at most ${getMaxReferenceImages(model)} reference images`);
    }
    const referenceFields = isFlux3ImageModel(model)
      ? referenceImages.length
        ? { images: referenceImages }
        : {}
      : isFlux2ImageModel(model)
        ? flux2InputImageFields(referenceImages)
        : { image_prompt };
    const requestBody: Record<string, unknown> = isFlux3ImageModel(model)
      ? // FLUX 3 rejects any field it does not define (422), so the body is built from an
        // allowlist and caller-supplied extras are not spread in.
        {
          prompt,
          safety_tolerance: this.clampSafetyTolerance(safety_tolerance),
          ...(supportsBflSeed(model) ? { seed } : {}),
          ...(supportsBflOutputFormat(model) ? { output_format: output_format || 'jpeg' } : {}),
          ...referenceFields,
          user,
        }
      : {
          prompt,
          safety_tolerance: this.clampSafetyTolerance(safety_tolerance),
          seed,
          output_format: output_format || 'jpeg',
          ...modelSpecificOptions,
          ...referenceFields,
          ...promptUpsamplingBodyFields(model, prompt_upsampling),
          user,
        };

    if (isBflUltraImageModel(model)) {
      // Ultra sizes by aspect_ratio; the other models by width and height.
      if (aspect_ratio) requestBody.aspect_ratio = aspect_ratio;
    } else {
      if (width) requestBody.width = width;
      if (height) requestBody.height = height;
    }
    return { model, body: this.stripNullFields(requestBody) };
  }

  async generate(prompt: string, options: BflGenerateOptions): Promise<string[]> {
    const { n = 1, model = ImageModels.FLUX_PRO_1_1 } = options;
    try {
      const { body } = this.buildGenerateRequest(prompt, options);
      // .log(), not .debug(), so the actual outbound payload is visible at the default log
      // level. prompt is truncated and the reference image redacted, matching every other prompt log
      // on this path (route: promptPreview.substring(0,100); GeminiImageService: same) -
      // logging full user prompts at the default level is a different posture than diagnosing
      // params, which is all this needed.
      const safeRequestBody = {
        ...body,
        prompt: prompt.length > 100 ? `${prompt.slice(0, 100)}...` : prompt,
        ...Object.fromEntries(
          Object.entries(body)
            .filter(([key]) => IMAGE_DATA_KEY.test(key))
            .map(([key, value]) => [
              key,
              Array.isArray(value)
                ? value.map(image => `[BASE64_DATA_${String(image).length}_CHARS]`)
                : `[BASE64_DATA_${String(value).length}_CHARS]`,
            ])
        ),
      };
      Logger.globalInstance.log('BFL Image generation request body:', safeRequestBody);

      // One task per image, in parallel.
      const urls = await Promise.all(
        Array.from({ length: n }).map(async () => {
          const task = await this.submitTask(model, body);
          Logger.globalInstance.debug('[DEBUG] BFL Image generation request submitted:', {
            ...task,
            endpoint: `${this.baseUrl}/${model}`,
            requestBody: safeRequestBody,
          });
          return this.pollForResult(task);
        })
      );

      Logger.globalInstance.debug('[DEBUG] BFL Image generation completed successfully, returning URLs:', {
        urls,
        model,
      });
      return urls;
    } catch (error) {
      throw this.toReportableError(error, 'image generation', `${this.baseUrl}/${model}`);
    }
  }

  /**
   * The body for one edit: FLUX Fill (image + mask), FLUX.2 (the source and references as input
   * images) or FLUX 3 (the source and references in `images`, optional region layout in the prompt).
   */
  buildEditRequest(
    image: string,
    prompt: string,
    {
      mask = null,
      steps = 50,
      model = ImageModels.FLUX_PRO_FILL,
      prompt_upsampling = false,
      seed = null,
      guidance = 60,
      output_format = 'jpeg',
      safety_tolerance = BFL_SAFETY_TOLERANCE.DEFAULT,
      referenceImages = [],
      edit_regions,
    }: ImageEditOptions
  ): BflTaskRequest {
    const flux2 = isFlux2ImageModel(model);
    const flux3 = isFlux3ImageModel(model);
    if (edit_regions?.length && !flux3) throw new Error('edit_regions are only supported on FLUX 3 models');
    if (flux3 && mask) throw new Error('FLUX 3 edits take no mask');
    if ((flux2 || flux3) && 1 + referenceImages.length > getMaxReferenceImages(model)) {
      throw new Error(
        `Model ${model} accepts at most ${getMaxReferenceImages(model)} input images (the source plus references)`
      );
    }
    if (flux3) {
      // FLUX 3 region edits: the layout is embedded in the prompt as inline JSON on a 0-1000
      // grid. The source image rides in the `images` array as a reference. The request goes to
      // the standard FLUX 3 generation endpoint (additionalProperties: false, so only
      // allowlisted fields are sent).
      const flux3Body = {
        prompt: edit_regions?.length ? formatBflEditRegionsPrompt(prompt, edit_regions) : prompt,
        images: [image, ...referenceImages],
        safety_tolerance: this.clampSafetyTolerance(safety_tolerance),
        ...(supportsBflSeed(model) ? { seed } : {}),
        ...(supportsBflOutputFormat(model) ? { output_format: toNonWebpOutputFormat(output_format) || 'jpeg' } : {}),
      };
      return { model, body: this.stripNullFields(flux3Body) };
    }
    if (flux2) {
      // FLUX.2 edits on its generation endpoint: no mask, steps or guidance, and the source rides as input_image.
      const flux2Body = {
        prompt,
        ...flux2InputImageFields([image, ...referenceImages]),
        ...promptUpsamplingBodyFields(model, prompt_upsampling),
        seed,
        safety_tolerance: this.clampSafetyTolerance(safety_tolerance),
        output_format: toNonWebpOutputFormat(output_format) || 'jpeg',
      };
      return { model, body: this.stripNullFields(flux2Body) };
    }
    const requestBody = {
      prompt,
      steps,
      safety_tolerance: this.clampSafetyTolerance(safety_tolerance),
      prompt_upsampling,
      seed,
      image,
      mask,
      guidance: guidance ?? undefined,
      // BFL rejects webp; ImageEditOptions.output_format is typed as ImageOutputFormat
      // (shared with providers that do accept it), so this call site must degrade it
      // itself rather than relying on the type to reject it at compile time.
      output_format: toNonWebpOutputFormat(output_format) || 'jpeg',
    };
    return { model, body: this.stripNullFields(requestBody) };
  }

  async edit(image: string, prompt: string, options: ImageEditOptions): Promise<ImageEditResponse> {
    const model = options.model ?? ImageModels.FLUX_PRO_FILL;
    try {
      const { body } = this.buildEditRequest(image, prompt, options);
      Logger.globalInstance.debug('[DEBUG] BFL Image edit request body:', redactInputImages(body));

      const task = await this.submitTask(model, body);
      Logger.globalInstance.debug('[DEBUG] BFL Image generation request submitted:', {
        ...task,
        endpoint: `${this.baseUrl}/${model}`,
        requestBody: redactInputImages(body),
      });

      const imageUrl = await this.pollForResult(task);
      Logger.globalInstance.debug('[DEBUG] Received BFL image URL:', { url: imageUrl, requestId: task.id, model });

      return { type: 'success' as const, dataUrl: imageUrl };
    } catch (error) {
      throw this.toReportableError(error, 'image editing', `${this.baseUrl}/${model}`);
    }
  }

  /** The body for one Kontext edit: the source rides as input_image. */
  buildTransformRequest(
    inputImage: string,
    prompt: string,
    {
      model = ImageModels.FLUX_KONTEXT_PRO,
      safety_tolerance = BFL_SAFETY_TOLERANCE.DEFAULT,
      prompt_upsampling = false,
      seed = null,
      output_format = 'jpeg',
      aspect_ratio,
      ...modelSpecificOptions
    }: BflTransformOptions
  ): BflTaskRequest {
    const requestBody = {
      prompt,
      input_image: inputImage,
      safety_tolerance: this.clampSafetyTolerance(safety_tolerance),
      prompt_upsampling,
      seed,
      output_format: output_format || 'jpeg',
      ...modelSpecificOptions,
      ...(aspect_ratio ? { aspect_ratio } : {}),
    };
    return { model, body: this.stripNullFields(requestBody) };
  }

  async transform(inputImage: string, prompt: string, options: BflTransformOptions): Promise<string> {
    const model = options.model ?? ImageModels.FLUX_KONTEXT_PRO;
    const endpoint = `${this.baseUrl}/${model}`;
    try {
      const { body } = this.buildTransformRequest(inputImage, prompt, options);
      Logger.globalInstance.debug('[DEBUG] BFL Kontext transformation request body (sanitized):', {
        ...body,
        input_image: `[BASE64_DATA_${inputImage.length}_CHARS]`,
      });

      const task = await this.submitTask(model, body);
      Logger.globalInstance.debug('[DEBUG] BFL Kontext transformation request submitted:', {
        requestId: task.id,
        pollingUrl: task.pollingUrl,
        endpoint,
        model,
      });

      const imageUrl = await this.pollForResult(task);
      Logger.globalInstance.debug('[DEBUG] Received BFL Kontext image URL:', {
        url: imageUrl.substring(0, 100) + '...',
        requestId: task.id,
        model,
      });

      return imageUrl;
    } catch (error) {
      throw this.toReportableError(error, 'Kontext transformation', endpoint);
    }
  }

  private headers(): Record<string, string> {
    return { accept: 'application/json', 'x-key': this.apiKey };
  }

  /**
   * Posts one task. Throws the axios error when BFL refuses it, so the caller can tell a 4xx (nothing queued) from a
   * transport failure (unknown). A 2xx without a task id cannot be followed, and is thrown as an error too.
   */
  async submitTask(model: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<BflTask> {
    const response = await axios.post(`${this.baseUrl}/${model}`, body, {
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      // The key header would follow a redirect off our host.
      maxRedirects: 0,
      ...(signal && { signal }),
    });
    const id: unknown = response.data?.id;
    const pollingUrl: unknown = response.data?.polling_url;
    if (typeof id !== 'string' || id.length === 0) {
      Logger.globalInstance.error('[BFL] submit response carried no request id', { data: response.data });
      throw new Error('BFL API did not return a request ID');
    }
    return {
      id,
      pollingUrl: typeof pollingUrl === 'string' && pollingUrl ? pollingUrl : `${this.baseUrl}/get_result?id=${id}`,
    };
  }

  /** One poll of a task. Throws the axios error on an HTTP failure; the status mapping never throws. */
  async checkTask(task: BflTask, signal?: AbortSignal): Promise<BflTaskStatus> {
    const response = await axios.get(task.pollingUrl, {
      headers: this.headers(),
      maxRedirects: 0,
      ...(signal && { signal }),
    });
    const { status, result } = (response.data ?? {}) as {
      status?: unknown;
      result?: { sample?: unknown; error?: unknown };
    };
    if (status === 'Ready' && typeof result?.sample === 'string' && result.sample) {
      return { state: 'ready', sampleUrl: result.sample };
    }
    if (typeof status === 'string' && MODERATED_STATUSES.has(status)) return { state: 'moderated', status };
    // BFL reports a failed task as `Error`; `Failed` is kept for older responses.
    if (status === 'Error' || status === 'Failed') {
      return { state: 'failed', message: `BFL image generation failed: ${String(result?.error || 'Unknown error')}` };
    }
    return { state: 'pending', status };
  }

  /** Whether a pending reading is one of BFL's documented in-progress statuses, not one it never told us about. */
  static isInProgressStatus(status: unknown): boolean {
    return typeof status === 'string' && IN_PROGRESS_STATUSES.has(status);
  }

  private getBackoffInterval(attempt: number, baseInterval: number): number {
    if (attempt < 15) return baseInterval;
    if (attempt < 30) return baseInterval * 2;
    if (attempt < 45) return baseInterval * 3;
    return baseInterval * 4;
  }

  private async pollForResult(task: BflTask, maxAttempts = 60, interval = 2000): Promise<string> {
    const startTime = Date.now();
    const requestId = task.id;
    let lastStatus: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let reading: BflTaskStatus;
      try {
        reading = await this.checkTask(task);
      } catch (pollError) {
        // 5xx and 429 are retryable; anything else aborts the poll and is reported once by the caller.
        const status = axios.isAxiosError(pollError) ? pollError.response?.status : undefined;
        if (status !== undefined && (status >= 500 || status === 429)) {
          Logger.globalInstance.warn(`[BFL] Retryable polling error (${status}), continuing to poll`, {
            requestId,
            attempt: attempt + 1,
          });
          continue;
        }
        throw pollError;
      }

      switch (reading.state) {
        case 'ready':
          Logger.globalInstance.debug('[DEBUG] BFL image generation completed successfully:', {
            requestId,
            attempt: attempt + 1,
            totalTime: `${Date.now() - startTime}ms`,
          });
          return reading.sampleUrl;
        case 'moderated':
          throw new ImageModerationBlockedError(
            'Your image request was flagged by content moderation. Please try adjusting your prompt to be less explicit or controversial.',
            requestId,
            'bfl',
            reading.status
          );
        case 'failed':
          // Reported once, by the caller's toReportableError.
          throw new Error(reading.message);
        case 'pending': {
          lastStatus = reading.status;
          const waitTime = this.getBackoffInterval(attempt, interval);
          Logger.globalInstance.debug(
            `[DEBUG] Image not ready yet, status: ${String(reading.status)}, waiting ${waitTime}ms (${attempt + 1}/${maxAttempts})`
          );
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    // Running out of attempts while BFL still reports the task running is a slow provider. Any other
    // status (e.g. `Task not found`, or one added later) means polling itself is broken, which must page.
    if (!BFLImageService.isInProgressStatus(lastStatus)) {
      throw new Error(`BFL polling ended on unexpected status: ${String(lastStatus)}`);
    }
    throw new ImageProviderUnavailableError(
      'Image generation is taking longer than usual and your request could not be completed. Please try again in a few minutes.',
      {
        provider: 'bfl',
        reason: 'polling_timeout',
        requestId,
        maxAttempts,
        elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
      }
    );
  }

  /**
   * Classify a failed BFL call. Expected failures (moderation, polling timeout, an unreachable network)
   * come back unlogged for the caller to report at warn; anything else is logged here at error first.
   */
  private toReportableError(error: unknown, operation: string, endpoint: string): Error {
    if (error instanceof ExpectedImageGenerationError) {
      return error;
    }
    if (axios.isAxiosError(error) && !error.response && error.code && UNREACHABLE_NETWORK_CODES.has(error.code)) {
      return new ImageProviderUnavailableError(
        'The image provider could not be reached. Please try again in a few minutes.',
        { provider: 'bfl', reason: error.code, endpoint }
      );
    }

    Logger.globalInstance.error(`[BFL] ${operation} failed:`, { endpoint, error: redactErrorForLog(error) });
    return error instanceof Error ? error : new Error(`BFL ${operation} error: Unknown error`);
  }
}
