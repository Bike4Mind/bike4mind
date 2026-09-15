import { Logger } from '@bike4mind/observability';
import { AIVideoService, AIVideoGenerationOptions, VideoGenerationStatus } from './AIVideoService';
import { VideoModels, VIDEO_SIZE_CONSTRAINTS } from '@bike4mind/common';
import axios from 'axios';

/**
 * OpenAI Sora Video Service
 *
 * Implements video generation using OpenAI's Sora API with polling pattern.
 *
 * Workflow:
 * 1. POST /videos -> returns job ID
 * 2. GET /videos/{id} -> poll status (queued, in_progress, completed, failed)
 * 3. GET /videos/{id}/content -> download MP4 when completed
 */
export class OpenAISoraVideoService extends AIVideoService {
  private baseUrl = 'https://api.openai.com/v1';

  /**
   * Default polling configuration. Capped to Lambda's 15-minute max timeout.
   * Videos typically take 5-30 minutes, so longer ones may time out.
   * Future improvement: webhooks or step functions for longer jobs.
   */
  private static readonly POLLING_CONFIG = {
    /** Maximum number of polling attempts (~14 min with 3s intervals, leaving buffer for processing) */
    maxAttempts: 280,
    /** Initial polling interval in milliseconds */
    initialInterval: 3000,
    /** Maximum polling interval in milliseconds */
    maxInterval: 5000,
    /** Backoff multiplier for exponential backoff */
    backoffMultiplier: 1.2,
  };

  constructor(apiKey: string, logger: Logger) {
    super(apiKey, logger);
  }

  /**
   * Generate a video from a text prompt: submit, poll to completion, return the URL.
   */
  async generate(
    prompt: string,
    {
      model = VideoModels.SORA_2,
      seconds = VIDEO_SIZE_CONSTRAINTS.SORA.defaultDuration,
      size = VIDEO_SIZE_CONSTRAINTS.SORA.defaultSize,
      user,
    }: AIVideoGenerationOptions
  ): Promise<string[]> {
    this.logger.info('[OpenAISoraVideoService] Starting video generation', {
      model,
      seconds,
      size,
      promptLength: prompt.length,
    });

    try {
      // Step 1: Submit the video generation request
      const jobId = await this.submitVideoGeneration(prompt, {
        model,
        seconds,
        size,
        user,
      });

      this.logger.info('[OpenAISoraVideoService] Video generation job submitted', { jobId });

      // Step 2: Poll for completion
      const videoUrl = await this.pollForCompletion(jobId);

      this.logger.info('[OpenAISoraVideoService] Video generation completed', {
        jobId,
        videoUrl: videoUrl.substring(0, 100) + '...',
      });

      return [videoUrl];
    } catch (error) {
      this.logger.error('[OpenAISoraVideoService] Video generation failed', { error });

      if (axios.isAxiosError(error)) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        throw new Error(`Sora video generation error: ${errorMessage}`);
      }

      throw error instanceof Error ? error : new Error('Unknown video generation error');
    }
  }

  /**
   * Submit a video generation request to the OpenAI API
   * Note: Sora API does not accept the 'user' parameter like other OpenAI endpoints
   * Note: Sora API expects 'seconds' as a string, not an integer
   */
  private async submitVideoGeneration(prompt: string, options: AIVideoGenerationOptions): Promise<string> {
    const seconds = options.seconds || VIDEO_SIZE_CONSTRAINTS.SORA.defaultDuration;
    const requestBody = {
      prompt,
      model: options.model || VideoModels.SORA_2,
      seconds: String(seconds), // Sora API expects string: "4", "8", or "12"
      size: options.size || VIDEO_SIZE_CONSTRAINTS.SORA.defaultSize,
      // Note: Sora API does not accept 'user' parameter - omitting it
    };

    this.logger.debug('[OpenAISoraVideoService] Submitting video generation request', {
      model: requestBody.model,
      seconds: requestBody.seconds,
      size: requestBody.size,
    });

    const response = await axios.post(`${this.baseUrl}/videos`, requestBody, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    const jobId = response.data.id;
    if (!jobId) {
      throw new Error('OpenAI API did not return a job ID');
    }

    return jobId;
  }

  /**
   * Poll for video generation completion with adaptive intervals
   */
  private async pollForCompletion(jobId: string): Promise<string> {
    const { maxAttempts, initialInterval, maxInterval, backoffMultiplier } = OpenAISoraVideoService.POLLING_CONFIG;

    let currentInterval = initialInterval;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const status = await this.getStatus(jobId);

        this.logger.debug('[OpenAISoraVideoService] Poll status', {
          jobId,
          status: status.status,
          progress: status.progress,
          attempt: attempt + 1,
        });

        if (status.status === 'completed' && status.videoUrl) {
          return status.videoUrl;
        }

        if (status.status === 'failed') {
          throw new Error(`Video generation failed: ${status.error || 'Unknown error'}`);
        }

        // Wait before next poll with adaptive backoff
        await this.sleep(currentInterval);

        // Increase interval up to max (exponential backoff for longer jobs)
        if (attempt > 10) {
          currentInterval = Math.min(currentInterval * backoffMultiplier, maxInterval);
        }
      } catch (pollError) {
        // Handle transient errors (5xx, rate limits) with retry
        if (axios.isAxiosError(pollError) && pollError.response) {
          const status = pollError.response.status;
          if (status >= 500 || status === 429) {
            this.logger.warn('[OpenAISoraVideoService] Transient error, retrying', {
              jobId,
              status,
              attempt: attempt + 1,
            });
            await this.sleep(currentInterval * 2); // Double wait on error
            continue;
          }
        }
        throw pollError;
      }
    }

    throw new Error(
      `Video generation timed out after ${maxAttempts} attempts (~${Math.round((maxAttempts * initialInterval) / 60000)} minutes)`
    );
  }

  /**
   * Get the status of a video generation job
   */
  async getStatus(jobId: string): Promise<VideoGenerationStatus> {
    const response = await axios.get(`${this.baseUrl}/videos/${jobId}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    const data = response.data;

    return {
      status: data.status,
      progress: data.progress,
      error: data.error?.message,
      videoUrl: data.status === 'completed' ? `${this.baseUrl}/videos/${jobId}/content` : undefined,
    };
  }

  /**
   * Download a completed video
   */
  async downloadVideo(jobId: string): Promise<Buffer> {
    const response = await axios.get(`${this.baseUrl}/videos/${jobId}/content`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      responseType: 'arraybuffer',
    });

    return Buffer.from(response.data);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
