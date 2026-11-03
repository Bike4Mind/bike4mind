import { getQuestErrorCode } from '@bike4mind/common';

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

type FailureLogger = {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/**
 * The one place an image-generation caller reports a failure: expected failures and running out of
 * credits at warn, anything else at error (which pages). `context` is extra caller metadata (ids),
 * never the prompt.
 */
export function logImageGenerationFailure(
  logger: FailureLogger,
  message: string,
  error: unknown,
  context?: Record<string, unknown>
): void {
  if (error instanceof ExpectedImageGenerationError) {
    logger.warn(message, { ...context, kind: error.kind, ...error.logContext });
    return;
  }
  // Out of credits is not an incident either: the user sees the message and the Add Credits CTA.
  if (getQuestErrorCode(error) === 'insufficient_credits') {
    logger.warn(message, { ...context, errorCode: 'insufficient_credits', detail: (error as Error).message });
    return;
  }
  if (context) {
    logger.error(message, error, context);
  } else {
    logger.error(message, error);
  }
}
