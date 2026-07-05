import { Logger } from '@bike4mind/observability';

/**
 * Options for video generation
 */
export interface AIVideoGenerationOptions {
  /** Model to use for generation */
  model?: string;

  /** Video duration in seconds */
  seconds?: number;

  /** Video resolution (e.g., '720x1280', '1280x720') */
  size?: string;

  /** User identifier for abuse tracking */
  user?: string;
}

/**
 * Response type for video generation status
 */
export interface VideoGenerationStatus {
  /** Current status of the video generation */
  status: 'queued' | 'in_progress' | 'completed' | 'failed';

  /** Progress percentage (0-100) if available */
  progress?: number;

  /** Error message if failed */
  error?: string;

  /** URL to download the video when completed */
  videoUrl?: string;
}

/**
 * Abstract class for AI Video Service
 * Defines the interface for video generation services
 */
export abstract class AIVideoService {
  constructor(
    protected apiKey: string,
    protected logger: Logger
  ) {}

  /**
   * Generate a video from a text prompt
   * @param prompt - Text description of the video to generate
   * @param options - Video generation options
   * @returns Array of video URLs (typically just one for video generation)
   */
  abstract generate(prompt: string, options: AIVideoGenerationOptions): Promise<string[]>;

  /**
   * Get the status of a video generation job
   * @param jobId - The job ID returned from generate()
   * @returns Current status of the job
   */
  abstract getStatus(jobId: string): Promise<VideoGenerationStatus>;

  /**
   * Download a completed video
   * @param jobId - The job ID of the completed video
   * @returns The video content as a Buffer
   */
  abstract downloadVideo(jobId: string): Promise<Buffer>;
}
