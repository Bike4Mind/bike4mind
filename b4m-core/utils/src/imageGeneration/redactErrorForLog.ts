import { redactLogValue } from '@bike4mind/observability';
import axios from 'axios';

const MAX_PROVIDER_DETAIL_LENGTH = 500;

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
      providerDetail: summarizeProviderDetail(error.response?.data),
      // headers intentionally omitted - request headers carry the x-key API secret.
    };
  }

  return redactLogValue(error);
}

/**
 * The provider's own explanation of a rejected request (e.g. a BFL 422 validation error), reduced to
 * field locations and messages. The raw body is never logged: a validation error echoes the offending
 * `input`, which can be the prompt, and the logger redacts a `data` key wholesale anyway.
 */
function summarizeProviderDetail(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }

  const { detail, error } = data as { detail?: unknown; error?: unknown };
  const summary = Array.isArray(detail)
    ? detail.map(summarizeValidationIssue).filter(Boolean).join('; ')
    : typeof detail === 'string'
      ? detail
      : typeof error === 'string'
        ? error
        : undefined;

  return summary ? summary.slice(0, MAX_PROVIDER_DETAIL_LENGTH) : undefined;
}

function summarizeValidationIssue(issue: unknown): string {
  if (typeof issue !== 'object' || issue === null) {
    return '';
  }
  const { loc, msg } = issue as { loc?: unknown; msg?: unknown };
  const location = Array.isArray(loc) ? loc.join('.') : '';
  const message = typeof msg === 'string' ? msg : '';
  return [location, message].filter(Boolean).join(': ');
}
