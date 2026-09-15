import { Logger } from '@bike4mind/observability';

export enum WorkflowErrorCategory {
  USER_INPUT_INVALID = 'USER_INPUT_INVALID',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  RATE_LIMITED = 'RATE_LIMITED',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export interface WorkflowErrorOptions {
  message: string;
  category: WorkflowErrorCategory;
  originalError?: any;
  context?: Record<string, any>;
  userMessage?: string;
}

export class WorkflowError extends Error {
  public readonly category: WorkflowErrorCategory;
  public readonly originalError?: any;
  public readonly context: Record<string, any>;
  public readonly userMessage: string;

  constructor(options: WorkflowErrorOptions) {
    super(options.message);
    this.name = 'WorkflowError';
    this.category = options.category;
    this.originalError = options.originalError;
    this.context = options.context || {};
    this.userMessage = options.userMessage || options.message;
  }

  public toSlackError() {
    return {
      error: {
        message: this.userMessage,
      },
    };
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterFactor?: number;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
  logger?: Logger
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: any;

  for (let attempt = 1; attempt <= opts.maxAttempts!; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;

      // Determine if we should retry based on error category or type
      const isTransient =
        error?.code === 'rate_limited' ||
        error?.code === 'ETIMEDOUT' ||
        error?.statusCode === 429 ||
        (error?.statusCode >= 500 && error?.statusCode < 600) ||
        (error instanceof WorkflowError &&
          (error.category === WorkflowErrorCategory.RATE_LIMITED ||
            error.category === WorkflowErrorCategory.SERVICE_UNAVAILABLE));

      if (!isTransient || attempt === opts.maxAttempts) {
        throw error;
      }

      // Calculate delay with exponential backoff and jitter
      const backoff = Math.min(opts.baseDelayMs! * Math.pow(opts.backoffMultiplier!, attempt - 1), opts.maxDelayMs!);
      const jitter = backoff * opts.jitterFactor! * (Math.random() * 2 - 1);
      const delay = backoff + jitter;

      if (logger) {
        logger.warn(`Transient error, retrying...`, {
          attempt,
          delay,
          error: error.message,
        });
      }

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export function categorizeError(error: any): WorkflowError {
  if (error instanceof WorkflowError) {
    return error;
  }

  // Handle known error types
  if (error?.code === 'slack_web_api_platform_error') {
    return new WorkflowError({
      message: error.message,
      category: WorkflowErrorCategory.INTERNAL_ERROR,
      originalError: error,
      userMessage: 'A Slack platform error occurred. Please try again.',
    });
  }

  if (error?.data?.error === 'not_in_channel' || error?.data?.error === 'channel_not_found') {
    return new WorkflowError({
      message: error.message,
      category: WorkflowErrorCategory.PERMISSION_DENIED,
      originalError: error,
      userMessage: 'The bot does not have access to the specified channel.',
    });
  }

  // Default to internal error
  return new WorkflowError({
    message: error.message || 'Unknown error',
    category: WorkflowErrorCategory.INTERNAL_ERROR,
    originalError: error,
    userMessage: 'An unexpected system error occurred.',
  });
}
