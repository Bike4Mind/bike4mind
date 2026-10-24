import { redactLogValue } from '@bike4mind/observability';
import axios from 'axios';

/**
 * Convert an unknown error into a safe, loggable shape.
 *
 * Logging a raw AxiosError (e.g. `console.error('...', error)`) serializes
 * `error.config.headers`, which for BFL requests contains the `x-key` API
 * secret - leaking it to CloudWatch. This returns only the useful
 * debugging fields and never includes request or response headers.
 */
export function redactErrorForLog(error: unknown): unknown {
  if (axios.isAxiosError(error)) {
    return {
      message: 'Provider request failed',
      code: error.code,
      status: error.response?.status,
      method: error.config?.method,
      // headers intentionally omitted - request headers carry the x-key API secret.
    };
  }

  return redactLogValue(error);
}
