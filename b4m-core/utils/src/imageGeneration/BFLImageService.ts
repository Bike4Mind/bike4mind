import { Logger } from '@bike4mind/observability';
import { AIImageService } from './AIImageService';
import axios from 'axios';
import { ImageModels, BFL_SAFETY_TOLERANCE } from '@bike4mind/common';
import { redactErrorForLog } from './redactErrorForLog';

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
      ...modelSpecificOptions
    }: {
      n?: number;
      user?: string;
      model?: ImageModels.FLUX_PRO | ImageModels.FLUX_PRO_1_1 | ImageModels.FLUX_PRO_ULTRA;
      safety_tolerance?: number;
      prompt_upsampling?: boolean;
      seed?: number | null;
      output_format?: 'jpeg' | 'png' | null;
      width?: number;
      height?: number;
      aspect_ratio?: string;
      image_prompt?: string;
      [key: string]: any;
    }
  ): Promise<string[]> {
    try {
      // Generate n images in parallel
      const urls = await Promise.all(
        Array.from({ length: n }).map(async () => {
          // Prepare request body based on model
          const requestBody: {
            prompt: string;
            image_prompt?: string;
            safety_tolerance: number;
            prompt_upsampling: boolean;
            seed: number | null;
            output_format: string;
            user: string;
            aspect_ratio?: string;
            width?: number;
            height?: number;
            [key: string]: any;
          } = {
            prompt,
            safety_tolerance: this.clampSafetyTolerance(safety_tolerance),
            prompt_upsampling,
            seed,
            image_prompt,
            output_format: output_format || 'jpeg',
            ...modelSpecificOptions,
            user,
          };

          if (model.includes('ultra')) {
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
          Logger.globalInstance.debug('[DEBUG] BFL Image generation request body:', cleanedBody);

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

          return imageUrl;
        })
      );

      Logger.globalInstance.debug('[DEBUG] BFL Image generation completed successfully, returning URLs:', {
        urls,
        model,
      });
      return urls;
    } catch (error) {
      Logger.globalInstance.error('[DEBUG] Error in BFL image generation:', redactErrorForLog(error));
      if (axios.isAxiosError(error)) {
        Logger.globalInstance.error('[DEBUG] Axios error details:', {
          status: error.response?.status,
          data: JSON.stringify(error.response?.data, null, 2),
          endpoint: `${this.baseUrl}/${model}`,
        });
      }

      throw error instanceof Error ? error : new Error('BFL image generation error: Unknown error');
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
    }: {
      steps?: number;
      mask: string | null;
      model?: ImageModels;
      prompt_upsampling?: boolean;
      seed?: number | null;
      guidance?: number;
      output_format?: 'jpeg' | 'png';
      safety_tolerance?: number;
    }
  ) {
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
        [key: string]: any;
      } = {
        prompt,
        steps,
        safety_tolerance: this.clampSafetyTolerance(safety_tolerance),
        prompt_upsampling,
        seed,
        image,
        mask,
        guidance,
        output_format: output_format,
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
      Logger.globalInstance.error('[DEBUG] Error in BFL image generation:', redactErrorForLog(error));
      if (axios.isAxiosError(error)) {
        Logger.globalInstance.error('[DEBUG] Axios error details:', {
          status: error.response?.status,
          data: JSON.stringify(error.response?.data, null, 2),
          endpoint: `${this.baseUrl}/${model}`,
        });
      }

      throw error instanceof Error ? error : new Error('BFL image generation error: Unknown error');
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
      [key: string]: any;
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
        [key: string]: any;
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
      try {
        const submitResponse = await axios.post(endpoint, cleanedBody, {
          headers: {
            accept: 'application/json',
            'x-key': this.apiKey,
            'Content-Type': 'application/json',
          },
        });

        Logger.globalInstance.debug(`[DEBUG] ✅ BFL API request successful:`, {
          status: submitResponse.status,
          statusText: submitResponse.statusText,
          responseDataKeys: Object.keys(submitResponse.data || {}),
          responseData: submitResponse.data,
        });

        const requestId = submitResponse.data.id;
        const pollingUrl = submitResponse.data.polling_url;
        if (!requestId) {
          Logger.globalInstance.error(`[DEBUG] ❌ No request ID in response:`, submitResponse.data);
          throw new Error('BFL API did not return a request ID');
        }

        Logger.globalInstance.debug('[DEBUG] ✅ BFL Kontext transformation request submitted:', {
          requestId,
          pollingUrl,
          endpoint,
          model,
          responseStatus: submitResponse.status,
        });

        // Poll for result using the polling_url from BFL
        Logger.globalInstance.debug(`[DEBUG] Starting polling for request ID: ${requestId}`);
        const imageUrl = await this.pollForResult(requestId, pollingUrl);
        Logger.globalInstance.debug('[DEBUG] ✅ Received BFL Kontext image URL:', {
          url: imageUrl.substring(0, 100) + '...',
          requestId,
          model,
        });

        return imageUrl;
      } catch (apiError) {
        Logger.globalInstance.error(`[DEBUG] ❌ BFL API request failed:`, {
          endpoint,
          error: redactErrorForLog(apiError),
          errorMessage: apiError instanceof Error ? apiError.message : 'Unknown error',
          isAxiosError: axios.isAxiosError(apiError),
          responseStatus: axios.isAxiosError(apiError) ? apiError.response?.status : undefined,
          responseData: axios.isAxiosError(apiError) ? apiError.response?.data : undefined,
        });
        throw apiError;
      }
    } catch (error) {
      Logger.globalInstance.error('[DEBUG] Error in BFL Kontext transformation:', redactErrorForLog(error));
      if (axios.isAxiosError(error)) {
        Logger.globalInstance.error('[DEBUG] Axios error details:', {
          status: error.response?.status,
          data: JSON.stringify(error.response?.data, null, 2),
          endpoint: `${this.baseUrl}/${model}`,
        });
      }

      throw error instanceof Error ? error : new Error('BFL Kontext transformation error: Unknown error');
    }
  }

  async variantions(image: Buffer, options: any): Promise<string[]> {
    throw new Error('Image variations are not supported by BlackForest Labs API');
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

        if (status === 'Request Moderated') {
          const errorMsg =
            'Your image request was flagged by content moderation. Please try adjusting your prompt to be less explicit or controversial.';
          Logger.globalInstance.error(`[DEBUG] ❌ Request moderated:`, {
            requestId,
            status,
            attempt: attempt + 1,
          });
          throw new Error(errorMsg);
        }

        if (status === 'Failed') {
          const errorMsg = `BFL image generation failed: ${result?.error || 'Unknown error'}`;
          Logger.globalInstance.error(`[DEBUG] ❌ Generation failed:`, {
            requestId,
            status,
            error: result?.error,
            attempt: attempt + 1,
          });
          throw new Error(errorMsg);
        }

        const waitTime = this.getBackoffInterval(attempt, interval);
        Logger.globalInstance.debug(
          `[DEBUG] ⏳ Image not ready yet, status: ${status}, waiting ${waitTime}ms before next attempt (${attempt + 1}/${maxAttempts})`
        );
        // Wait before next attempt with stepped backoff
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } catch (pollError) {
        Logger.globalInstance.error(`[DEBUG] ❌ Error during polling attempt ${attempt + 1}:`, {
          requestId,
          attempt: attempt + 1,
          error: redactErrorForLog(pollError),
          errorMessage: pollError instanceof Error ? pollError.message : 'Unknown polling error',
        });

        if (axios.isAxiosError(pollError)) {
          Logger.globalInstance.error('[DEBUG] Axios polling error details:', {
            status: pollError.response?.status,
            statusText: pollError.response?.statusText,
            data: pollError.response?.data,
            endpoint: effectivePollingUrl,
            requestId,
            attempt: attempt + 1,
          });
        }

        // If it's a network error or 5xx, continue trying
        if (axios.isAxiosError(pollError) && pollError.response) {
          const status = pollError.response.status;
          if (status >= 500 || status === 429) {
            Logger.globalInstance.debug(`[DEBUG] ⚠️ Retryable error (${status}), continuing to poll...`);
            continue;
          }
        }

        Logger.globalInstance.error(`[DEBUG] ❌ Non-retryable polling error, aborting`);
        throw pollError;
      }
    }

    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
    Logger.globalInstance.error(`[DEBUG] ❌ Polling timeout:`, {
      requestId,
      maxAttempts,
      totalTime: `${elapsedSeconds}s`,
    });
    throw new Error(
      'Image generation is taking longer than usual and your request could not be completed. Please try again in a few minutes.'
    );
  }
}
