import { DecisionProviderError } from './types';

/** `retry-after-ms`, else `retry-after` as seconds or an HTTP date; undefined when absent or unparseable. */
export const parseRetryAfterMs = (headers: Headers, now: number = Date.now()): number | undefined => {
  const milliseconds = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds;
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
};

// 529 is the non-standard "overloaded" some decision vendors return.
const OVERLOADED_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

/** The transport-level classification every protocol shares; vendor bodies refine 4xx further. */
export const classifyStatus = (status: number): 'overloaded' | 'rejected_key' | 'client_error' | 'upstream' => {
  if (OVERLOADED_STATUSES.has(status)) return 'overloaded';
  if (status === 401 || status === 403) return 'rejected_key';
  if (status >= 400 && status < 500) return 'client_error';
  return 'upstream';
};

/** POSTs JSON; a network failure or abort surfaces as `overloaded`, so the retry policy sees one error type. */
export const postJson = async (url: string, apiKey: string, body: unknown, signal: AbortSignal): Promise<Response> => {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
  } catch (error) {
    const reason = signal.aborted ? 'timed out' : error instanceof Error ? error.message : String(error);
    throw new DecisionProviderError('overloaded', `decision provider request failed: ${reason}`);
  }
};
