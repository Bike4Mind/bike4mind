import type { Logger } from '@bike4mind/observability';

const ALLOWED_HEADERS = ['anthropic-workspace-id', 'retry-after', 'request-id'] as const;
const RATE_LIMIT_HEADER_PREFIX = 'anthropic-ratelimit-';

type HeaderSource = { get(name: string): string | null; forEach(cb: (value: string, key: string) => void): void };

/** Allowlisted Anthropic response headers only; never request headers or credentials. */
export function pickRateLimitHeaders(headers: HeaderSource | null | undefined): Record<string, string> {
  const picked: Record<string, string> = {};
  if (!headers || typeof headers.get !== 'function') return picked;
  for (const name of ALLOWED_HEADERS) {
    const value = headers.get(name);
    if (value) picked[name] = value;
  }
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith(RATE_LIMIT_HEADER_PREFIX)) picked[lower] = value;
  });
  return picked;
}

function requestedModel(init: RequestInit | undefined): string | undefined {
  if (typeof init?.body !== 'string') return undefined;
  try {
    const model = (JSON.parse(init.body) as { model?: unknown }).model;
    return typeof model === 'string' ? model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Logs one structured warn per 429/529 response. Reads a clone of the body so the
 * SDK still gets an unread response.
 */
export async function logAnthropicLimitResponse(
  logger: Logger,
  response: Response,
  init: RequestInit | undefined
): Promise<void> {
  if (response.status !== 429 && response.status !== 529) return;
  try {
    let errorType: string | undefined;
    let anthropicMessage: string | undefined;
    try {
      const parsed = JSON.parse(await response.clone().text()) as { error?: { type?: string; message?: string } };
      errorType = parsed.error?.type;
      anthropicMessage = parsed.error?.message?.slice(0, 500);
    } catch {
      // body missing or not JSON; headers are still useful
    }
    const label = response.status === 429 ? 'rate limited (429)' : 'overloaded (529)';
    logger.warn(`[AnthropicBackend] Anthropic API ${label}`, {
      status: response.status,
      model: requestedModel(init),
      errorType,
      anthropicMessage,
      headers: pickRateLimitHeaders(response.headers),
    });
  } catch {
    // logging must never affect the request
  }
}
