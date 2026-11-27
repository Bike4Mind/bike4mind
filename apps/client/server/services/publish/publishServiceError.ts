import { HTTPError } from '@bike4mind/server-utils/utils/errors';

/**
 * An expected refusal from a publish service. `additionalInfo.errorCode` is the machine-readable code;
 * any other keys are extra body fields. Legacy handlers match on this class to re-shape the error, so
 * errors thrown by dependencies (a 429 from the rate limiter) still pass through untouched.
 */
export class PublishServiceError extends HTTPError {
  constructor(statusCode: number, message: string, additionalInfo?: Record<string, unknown>) {
    super(statusCode, message, additionalInfo);
    this.name = 'PublishServiceError';
  }

  get errorCode(): string | undefined {
    const code = this.additionalInfo?.errorCode;
    return typeof code === 'string' ? code : undefined;
  }
}
