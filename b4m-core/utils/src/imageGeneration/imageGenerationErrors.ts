import type { Logger } from '@bike4mind/observability';

export type ExpectedImageFailureKind = 'moderation_blocked' | 'provider_unavailable' | 'input_rejected';

/**
 * An image request that failed for an expected, non-incident reason. Adapters throw these without
 * error-level logging and callers report them once through `logImageGenerationFailure`, at warn, so
 * they stay out of the error-level Slack alert channel. The message is user-facing.
 */
export abstract class ExpectedImageGenerationError extends Error {
  abstract readonly kind: ExpectedImageFailureKind;

  constructor(
    message: string,
    /** Safe-to-log diagnostics: never the prompt, never request headers. */
    readonly logContext: Record<string, unknown>
  ) {
    super(message);
  }
}

/** The provider refused the prompt or the output on content-policy grounds. */
export class ImageModerationBlockedError extends ExpectedImageGenerationError {
  readonly kind = 'moderation_blocked' as const;

  constructor(
    message: string,
    readonly requestId: string,
    provider = 'openai',
    reason?: string
  ) {
    super(message, { provider, requestId, ...(reason && { reason }) });
    this.name = 'ImageModerationBlockedError';
  }
}

/** The provider was unreachable or did not finish in time. Retrying later is the remedy. */
export class ImageProviderUnavailableError extends ExpectedImageGenerationError {
  readonly kind = 'provider_unavailable' as const;

  constructor(message: string, logContext: Record<string, unknown> & { provider: string; reason: string }) {
    super(message, logContext);
    this.name = 'ImageProviderUnavailableError';
  }
}

/** The request cannot run with what the user supplied (e.g. an image-to-image model with no input image). */
export class ImageInputRejectedError extends ExpectedImageGenerationError {
  readonly kind = 'input_rejected' as const;

  constructor(message: string, logContext: Record<string, unknown> & { reason: string }) {
    super(message, logContext);
    this.name = 'ImageInputRejectedError';
  }
}

/**
 * The one place an image-generation caller reports a failure: expected failures at warn, anything
 * else at error (which pages).
 */
export function logImageGenerationFailure(
  logger: Pick<Logger, 'warn' | 'error'>,
  message: string,
  error: unknown
): void {
  if (error instanceof ExpectedImageGenerationError) {
    logger.warn(message, { kind: error.kind, ...error.logContext });
    return;
  }
  logger.error(message, error);
}
