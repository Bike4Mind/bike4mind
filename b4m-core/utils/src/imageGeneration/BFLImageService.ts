import { Logger } from '@bike4mind/observability';
import { AIImageService, ImageEditOptions, ImageEditResponse } from './AIImageService';
import axios from 'axios';
import {
  ImageModels,
  BFL_SAFETY_TOLERANCE,
  type BFLImageModel,
  isBflUltraImageModel,
  isFlux2ImageModel,
  getMaxReferenceImages,
  supportsPromptUpsampling,
  toNonWebpOutputFormat,
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
    const clamped = Math.min(Math.max(value, BFL_SAFETY_TOLERANCE.MIN), BFL_SAFETY_TOLERANCE.MAX);
    if (clamped !== value) {
      Logger.globalInstance.warn(
        `[BFLImageService] safety_tolerance ${value} clamped to ${clamped} (hard cap ${BFL_SAFETY_TOLERANCE.MAX})`
      );
    }
    return clamped;
  }

  constructor(apiKey: string, logger: Logger, imageProcessorLambdaName?: string) {
    super(apiKey, logger, imageProcessorLambdaName);
  }

  async generate(
    prompt: string,
    {
      n = 1,
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
    }: {
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
    }
  ): Promise<string[]> {
    try {
      const referenceImages = [...new Set([...(image_prompt ? [image_prompt] : []), ...reference_images])];
      if (reference_images.length && !isFlux2ImageModel(model)) {
        throw new Error(`Model ${model} does not support multiple reference images`);
      }
      if (isFlux2ImageModel(model) && referenceImages.length > getMaxReferenceImages(model)) {
        throw new Error(`Model ${model} accepts at most ${getMaxReferenceImages(model)} reference images`);
      }
      const referenceFields = isFlux2ImageModel(model)
        ? Object.fromEntries(
            referenceImages.map((image, index) => [index === 0 ? 'input_image' : `input_image_${index + 1}`, image])
          )
        : { image_prompt };
      const promptUpsamplingFields = !supportsPromptUpsampling(model)
        ? {}
        : isFlux2ImageModel(model) && model !== ImageModels.FLUX_2_FLEX
          ? { disable_pup: !prompt_upsampling }
          : { prompt_upsampling };
      // Generate n images in parallel
      const urls = await Promise.all(
        Array.from({ length: n }).map(async () => {
          // Prepare request body based on model
          const requestBody: {
            prompt: string;
            image_prompt?: string;
            safety_tolerance: number;
            seed: number | null;
            output_format: string;
            user: string;
            aspect_ratio?: string;
            width?: number;
            height?: number;
            [key: string]: unknown;
          } = {
            prompt,
            safety_tolerance: this.clampSafetyTolerance(safety_tolerance),
            seed,
            output_format: output_format || 'jpeg',
            ...modelSpecificOptions,
            ...referenceFields,
            ...promptUpsamplingFields,
            user,
          };

          if (isBflUltraImageModel(model)) {
            // For Ultra models, use aspect_ratio
            if (aspect_ratio) {
              requestBody.aspect_ratio = aspect_ratio;
              Logger.globalInstance.debug(`[DEBUG] Using aspect_ratio: ${aspect_ratio} for Ultra model`);
            }
          } else {
            // For Pro models, use width and height
            if (width) {
              requestBody.width = width;
            }
            if (height) {
              requestBody.height = height;
            }
          }

          const cleanedBody = this.stripNullFields(requestBody);
          // .log(), not .debug(), so the actual outbound payload is visible at the default log
          // level. prompt is truncated and the reference image redacted, matching every other prompt log
          // on this path (route: promptPreview.substring(0,100); GeminiImageService: same) -
          // logging full user prompts at the default level is a different posture than diagnosing
          // params, which is all this needed.
          const safeRequestBody = {
            ...cleanedBody,
            prompt: prompt.length > 100 ? `${prompt.slice(0, 100)}...` : prompt,
            ...Object.fromEntries(
              Object.entries(cleanedBody)
                .filter(
                  ([key, value]) => /^(?:image_prompt|input_image(?:_\d+)?)$/.test(key) && typeof value === 'string'
                )
                .map(([key, value]) => [key, `[BASE64_DATA_${String(value).length}_CHARS]`])
            ),
          };
          Logger.globalInstance.log('BFL Image generation request body:', safeRequestBody);

          // Submit a new generation request for each image
          const submitResponse = await axios.post(`${this.baseUrl}/${model}`, cleanedBody, {
            headers: {
              accept: 'application/json',
              'x-key': this.apiKey,
              'Content-Type': 'application/json',
            },
          });

          const requestId = submitResponse.data.id;
          const pollingUrl = submitResponse.data.polling_url;
          Logger.globalInstance.debug('[DEBUG] BFL Image generation request submitted:', {
            id: requestId,
            pollingUrl,
            responseData: submitResponse.data,
            endpoint: `${this.baseUrl}/${model}`,
            requestBody: safeRequestBody,
          });

          // Poll for this specific request's result using the polling_url from BFL
          const imageUrl = await this.pollForResult(requestId, pollingUrl);
          Logger.globalInstance.debug('[DEBUG] Received BFL image URL:', {
            url: imageUrl,
            requestId: requestId,
            model: model,
          });

          return imageUrl;
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

  async edit(
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
    }: ImageEditOptions
  ): Promise<ImageEditResponse> {
    try {
      // Prepare request body based on model
      const requestBody: {
        prompt: string;
        safety_tolerance: number;
        prompt_upsampling: boolean;
        seed: number | null;
        output_format: string;
        aspect_ratio?: string;
        guidance?: number;
        [key: string]: unknown;
      } = {
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

      const cleanedBody = this.stripNullFields(requestBody);
      Logger.globalInstance.debug('[DEBUG] BFL Image edit request body:', cleanedBody);

      // Submit a new generation request for each image
      const submitResponse = await axios.post(`${this.baseUrl}/${model}`, cleanedBody, {
        headers: {
          accept: 'application/json',
          'x-key': this.apiKey,
          'Content-Type': 'application/json',
        },
      });

      const requestId = submitResponse.data.id;
      const pollingUrl = submitResponse.data.polling_url;
      Logger.globalInstance.debug('[DEBUG] BFL Image generation request submitted:', {
        id: requestId,
        pollingUrl,
        responseData: submitResponse.data,
        endpoint: `${this.baseUrl}/${model}`,
        requestBody,
      });

      // Poll for this specific request's result using the polling_url from BFL
      const imageUrl = await this.pollForResult(requestId, pollingUrl);
      Logger.globalInstance.debug('[DEBUG] Received BFL image URL:', {
        url: imageUrl,
        requestId: requestId,
        model: model,
      });

      return { type: 'success' as const, dataUrl: imageUrl };
    } catch (error) {
      throw this.toReportableError(error, 'image editing', `${this.baseUrl}/${model}`);
    } finally {
      // Delete mask file
    }
  }

  async transform(
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
    }: {
      model?: ImageModels.FLUX_KONTEXT_PRO | ImageModels.FLUX_KONTEXT_MAX;
      safety_tolerance?: number;
      prompt_upsampling?: boolean;
      seed?: number | null;
      output_format?: 'jpeg' | 'png';
      aspect_ratio?: string;
      [key: string]: unknown;
    }
  ): Promise<string> {
    Logger.globalInstance.debug(`[DEBUG] === BFL TRANSFORM SERVICE ===`);
    Logger.globalInstance.debug(`[DEBUG] Transform input validation:`, {
      hasInputImage: !!inputImage,
      inputImageLength: inputImage?.length,
      promptLength: prompt?.length,
      model,
      safety_tolerance,
      prompt_upsampling,
      seed,
      output_format,
      aspect_ratio,
      modelSpecificOptionsKeys: Object.keys(modelSpecificOptions),
    });
    try {
      Logger.globalInstance.debug(`[DEBUG] Preparing BFL Kontext request body...`);

      // Prepare request body for Kontext models
      const requestBody: {
        prompt: string;
        input_image: string;
        safety_tolerance: number;
        prompt_upsampling: boolean;
        seed: number | null;
        output_format: string;
        aspect_ratio?: string;
        [key: string]: unknown;
      } = {
        prompt,
        input_image: inputImage,
        safety_tolerance: this.clampSafetyTolerance(safety_tolerance),
        prompt_upsampling,
        seed,
        output_format: output_format || 'jpeg',
        ...modelSpecificOptions,
      };

      if (aspect_ratio) {
        requestBody.aspect_ratio = aspect_ratio;
        Logger.globalInstance.debug(`[DEBUG] ✅ Added aspect_ratio: ${aspect_ratio} for Kontext model`);
      }

      const cleanedBody = this.stripNullFields(requestBody);
      const safeRequestBody = {
        ...cleanedBody,
        input_image: `[BASE64_DATA_${requestBody.input_image.length}_CHARS]`,
      };
      Logger.globalInstance.debug('[DEBUG] BFL Kontext transformation request body (sanitized):', safeRequestBody);

      const endpoint = `${this.baseUrl}/${model}`;
      Logger.globalInstance.debug(`[DEBUG] Making request to BFL endpoint: ${endpoint}`);

      // Submit transformation request
      const submitResponse = await axios.post(endpoint, cleanedBody, {
        headers: {
          accept: 'application/json',
          'x-key': this.apiKey,
          'Content-Type': 'application/json',
        },
      });

      Logger.globalInstance.debug(`[DEBUG] BFL API request successful:`, {
        status: submitResponse.status,
        statusText: submitResponse.statusText,
        responseDataKeys: Object.keys(submitResponse.data || {}),
        responseData: submitResponse.data,
      });

      const requestId = submitResponse.data.id;
      const pollingUrl = submitResponse.data.polling_url;
      if (!requestId) {
        Logger.globalInstance.error(`[DEBUG] No request ID in response:`, submitResponse.data);
        throw new Error('BFL API did not return a request ID');
      }

      Logger.globalInstance.debug('[DEBUG] BFL Kontext transformation request submitted:', {
        requestId,
        pollingUrl,
        endpoint,
        model,
        responseStatus: submitResponse.status,
      });

      // Poll for result using the polling_url from BFL
      Logger.globalInstance.debug(`[DEBUG] Starting polling for request ID: ${requestId}`);
      const imageUrl = await this.pollForResult(requestId, pollingUrl);
      Logger.globalInstance.debug('[DEBUG] Received BFL Kontext image URL:', {
        url: imageUrl.substring(0, 100) + '...',
        requestId,
        model,
      });

      return imageUrl;
    } catch (error) {
      throw this.toReportableError(error, 'Kontext transformation', `${this.baseUrl}/${model}`);
    }
  }

  private getBackoffInterval(attempt: number, baseInterval: number): number {
    if (attempt < 15) return baseInterval;
    if (attempt < 30) return baseInterval * 2;
    if (attempt < 45) return baseInterval * 3;
    return baseInterval * 4;
  }

  private async pollForResult(
    requestId: string,
    pollingUrl?: string,
    maxAttempts = 60,
    interval = 2000
  ): Promise<string> {
    const startTime = Date.now();
    // Use the polling URL provided by BFL, or fall back to constructing from baseUrl
    const effectivePollingUrl = pollingUrl || `${this.baseUrl}/get_result?id=${requestId}`;
    Logger.globalInstance.debug(`[DEBUG] === BFL POLLING PROCESS ===`);
    Logger.globalInstance.debug(`[DEBUG] Starting polling with config:`, {
      requestId,
      pollingUrl: effectivePollingUrl,
      maxAttempts,
      baseInterval: interval,
    });

    let lastStatus: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        Logger.globalInstance.debug(
          `[DEBUG] 🔄 Polling attempt ${attempt + 1}/${maxAttempts} for request ${requestId}`
        );

        const pollResponse = await axios.get(effectivePollingUrl, {
          headers: {
            accept: 'application/json',
            'x-key': this.apiKey,
          },
        });

        Logger.globalInstance.debug(`[DEBUG] Poll response received:`, {
          status: pollResponse.status,
          statusText: pollResponse.statusText,
          dataKeys: Object.keys(pollResponse.data || {}),
          data: pollResponse.data,
        });

        const { status, result } = pollResponse.data;
        lastStatus = status;
        Logger.globalInstance.debug(`[DEBUG] Poll status analysis:`, {
          requestId,
          status,
          hasResult: !!result,
          resultKeys: result ? Object.keys(result) : [],
          hasSample: result?.sample ? true : false,
          attempt: attempt + 1,
        });

        if (status === 'Ready' && result?.sample) {
          Logger.globalInstance.debug(`[DEBUG] ✅ BFL image generation completed successfully:`, {
            requestId,
            status,
            imageUrl: result.sample.substring(0, 100) + '...',
            attempt: attempt + 1,
            totalTime: `${Date.now() - startTime}ms`,
          });
          return result.sample;
        }

        if (MODERATED_STATUSES.has(status)) {
          throw new ImageModerationBlockedError(
            'Your image request was flagged by content moderation. Please try adjusting your prompt to be less explicit or controversial.',
            requestId,
            'bfl',
            status
          );
        }

        // BFL reports a failed task as `Error`; `Failed` is kept for older responses.
        if (status === 'Error' || status === 'Failed') {
          // Reported once, by the caller's toReportableError.
          throw new Error(`BFL image generation failed: ${result?.error || 'Unknown error'}`);
        }

        const waitTime = this.getBackoffInterval(attempt, interval);
        Logger.globalInstance.debug(
          `[DEBUG] ⏳ Image not ready yet, status: ${status}, waiting ${waitTime}ms before next attempt (${attempt + 1}/${maxAttempts})`
        );
        // Wait before next attempt with stepped backoff
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } catch (pollError) {
        // Our own outcome errors from the status checks above: already classified, not a polling failure.
        if (!axios.isAxiosError(pollError)) {
          throw pollError;
        }

        // 5xx and 429 are retryable; anything else aborts the poll and is reported once by the caller.
        const status = pollError.response?.status;
        if (status !== undefined && (status >= 500 || status === 429)) {
          Logger.globalInstance.warn(`[BFL] Retryable polling error (${status}), continuing to poll`, {
            requestId,
            attempt: attempt + 1,
          });
          continue;
        }

        throw pollError;
      }
    }

    // Running out of attempts while BFL still says Pending is a slow provider. Any other status
    // (e.g. `Task not found`, or one added later) means polling itself is broken, which must page.
    if (lastStatus !== 'Pending') {
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
