import type { ProviderOutput, ProviderTerminalResult } from '../generationProviders/types';

const MAX_SNIPPET_CHARS = 200;
const POLICY_PATTERN = /content[_ -]?policy|moderation|policy[_ -]?violation|violates|bad_prompt|prohibited/i;

type ErrorFacts = { status: number | undefined; text: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

const bodyToText = (body: unknown): string => {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8', 0, 4096);
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8', 0, 4096);
  if (isRecord(body)) return JSON.stringify(body).slice(0, 4096);
  return '';
};

// Services throw OpenAI SDK errors (`status`, `code`, `error`), axios errors (`response.status`, `response.data`)
// or ElevenLabsSoundGenerator errors (`status`, `detail`); read all three shapes defensively.
const factsOf = (error: unknown): ErrorFacts => {
  if (!isRecord(error)) return { status: undefined, text: '' };
  const response = isRecord(error.response) ? error.response : undefined;
  const status = asNumber(error.status) ?? asNumber(response?.status);
  const text = [
    typeof error.code === 'string' ? error.code : '',
    typeof error.message === 'string' ? error.message : '',
    bodyToText(error.error),
    bodyToText(error.detail),
    bodyToText(response?.data),
  ].join(' ');
  return { status, text };
};

/**
 * Maps a thrown service error to a terminal result when the provider definitively answered with a refusal
 * (4xx), and rethrows everything else (timeout, abort, network error, 5xx), whose outcome is unknown and
 * which the job handler must not retry. `raw.status` carries the HTTP status.
 */
export const toAudioProviderResult = (error: unknown, vendor: string): ProviderTerminalResult => {
  const { status, text } = factsOf(error);
  if (status === undefined || status < 400 || status >= 500) throw error;
  const raw = { status, snippet: text.trim().slice(0, MAX_SNIPPET_CHARS) };
  if (status === 429) return { status: 'failed', retryable: true, message: `${vendor}_rate_limited`, raw };
  if (status === 401 || status === 403) {
    return { status: 'failed', retryable: false, message: `${vendor}_credential_rejected`, raw: { status } };
  }
  if ((status === 400 || status === 422) && POLICY_PATTERN.test(text)) {
    return { status: 'blocked', reason: `${vendor}_content_policy`, raw };
  }
  return { status: 'failed', retryable: false, message: `${vendor}_http_${status}`, raw };
};

/** True when the provider rejected the API key (HTTP 401 or 403), so the key rather than the request is at fault. */
export const isCredentialRejectionResult = (result: ProviderTerminalResult): boolean =>
  result.status === 'failed' && isRecord(result.raw) && (result.raw.status === 401 || result.raw.status === 403);

export const decodeInlineOutput = (output: ProviderOutput): Buffer => {
  if (output.kind !== 'inline') throw new Error('audio_provider_unexpected_url_output');
  return Buffer.from(output.base64, 'base64');
};
