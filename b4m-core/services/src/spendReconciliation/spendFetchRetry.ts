export interface ProviderSpendDiagnostic {
  provider: 'Anthropic' | 'OpenAI';
  event: 'retry' | 'failure';
  attempt: number;
  status?: number;
  reason: 'http' | 'network' | 'timeout' | 'invalid-json' | 'invalid-headers' | 'deadline' | 'quota';
  requestId?: string;
  rateLimitHeaders: Record<string, string>;
  delayMs?: number;
}

export interface ProviderSpendFetchOptions {
  deadlineMs?: number;
  onDiagnostic?: (diagnostic: ProviderSpendDiagnostic) => void;
}

export const DEFAULT_SPEND_DEADLINE_MS = 240_000;
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;
// A 429 that carries no usable wait header is retried for at least a minute in total, so a
// provider's per-minute request window has rolled over before the last attempt.
const MAX_RATE_LIMIT_ATTEMPTS = 6;
const RATE_LIMIT_BACKOFF_BASE_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
const ATTEMPT_TIMEOUT_MS = 30_000;
const RESET_HEADERS = [
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-reset',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
];
const WAIT_HEADERS = ['retry-after-ms', 'retry-after', ...RESET_HEADERS];
// Logged only, never waited on: they say which limit a 429 hit.
const QUOTA_HEADERS = [
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
];

function durationMs(value: string): number | undefined {
  if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(value)) return undefined;
  let duration = 0;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    duration += Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]] ?? 0);
  }
  return Number.isFinite(duration) ? duration : undefined;
}

function waitFromHeader(name: string, value: string, now: number): number | undefined {
  if (name === 'retry-after-ms') return /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined;
  if (name === 'retry-after' && /^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1000;
  if (name.startsWith('x-ratelimit-reset-')) return durationMs(value);
  if (
    !/^(?:[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))$/.test(
      value
    )
  )
    return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

function safeHeaders(headers: Headers | undefined, secrets: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [...WAIT_HEADERS, ...QUOTA_HEADERS]) {
    const value = headers?.get(name);
    if (!value || value.length > 100 || secrets.some(secret => value.includes(secret))) continue;
    const valid = QUOTA_HEADERS.includes(name)
      ? /^\d{1,12}$/.test(value)
      : waitFromHeader(name, value, Date.now()) !== undefined;
    if (valid) result[name] = value;
  }
  return result;
}

function isQuotaError(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const error = (body as { error?: { code?: unknown; type?: unknown } }).error;
  if (!error || typeof error !== 'object') return false;
  return [error.code, error.type].some(
    value => typeof value === 'string' && /quota|^billing_hard_limit_reached$/i.test(value)
  );
}

export async function fetchSpendJson<T>(
  provider: ProviderSpendDiagnostic['provider'],
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch,
  options: ProviderSpendFetchOptions = {}
): Promise<T> {
  const deadline = options.deadlineMs ?? Date.now() + DEFAULT_SPEND_DEADLINE_MS;
  const report = (diagnostic: ProviderSpendDiagnostic) => {
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      /* Diagnostics must not affect billing reads. */
    }
  };

  let credentials: Headers;
  try {
    credentials = new Headers(init.headers);
  } catch {
    report({ provider, event: 'failure', attempt: 1, reason: 'invalid-headers', rateLimitHeaders: {} });
    throw new Error(`${provider} API: invalid-headers`);
  }
  const secrets = [credentials.get('x-api-key'), credentials.get('authorization')?.replace(/^Bearer /i, '')].filter(
    (value): value is string => Boolean(value)
  );

  for (let attempt = 1; attempt <= MAX_RATE_LIMIT_ATTEMPTS; attempt++) {
    const remainingMs = deadline - Date.now();
    let status: number | undefined;
    let headers: Headers | undefined;
    let reason: ProviderSpendDiagnostic['reason'] = 'deadline';
    let retryable = false;
    if (remainingMs > 0) {
      const controller = new AbortController();
      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => {
              timedOut = true;
              controller.abort();
              reject(new Error('Provider request timeout'));
            },
            Math.min(ATTEMPT_TIMEOUT_MS, remainingMs)
          );
        });
        const result = await Promise.race([
          (async () => {
            const response = await fetchFn(url, { ...init, signal: controller.signal });
            status = response.status;
            headers = response.headers;
            if (response.ok) return { ok: true as const, body: (await response.json()) as T };
            let body: unknown;
            if (response.status === 429) {
              try {
                body = await response.json();
              } catch (error) {
                if (controller.signal.aborted || error instanceof TypeError) throw error;
              }
            } else {
              void response.body?.cancel().catch(() => undefined);
            }
            return { ok: false as const, body };
          })(),
          timeout,
        ]);
        if (result.ok) return result.body;
        reason = status === 429 && isQuotaError(result.body) ? 'quota' : 'http';
        retryable = reason !== 'quota' && (status === 429 || (status !== undefined && status >= 500 && status <= 599));
      } catch (error) {
        reason = timedOut ? 'timeout' : error instanceof SyntaxError ? 'invalid-json' : 'network';
        retryable = timedOut || error instanceof TypeError || (error instanceof Error && error.name === 'AbortError');
      } finally {
        clearTimeout(timeoutId);
      }
    }
    const requestId = headers?.get('request-id') ?? headers?.get('x-request-id');
    const diagnostic: ProviderSpendDiagnostic = {
      provider,
      event: 'failure',
      attempt,
      status,
      reason,
      rateLimitHeaders: safeHeaders(headers, secrets),
      ...(requestId && /^[\w.:-]{1,200}$/.test(requestId) && !secrets.some(secret => requestId.includes(secret))
        ? { requestId }
        : {}),
    };
    const waits = Object.entries(diagnostic.rateLimitHeaders)
      .filter(
        ([name]) =>
          WAIT_HEADERS.includes(name) &&
          (name.startsWith('retry-after') ||
            !headers?.get(name.replace('-reset', '-remaining')) ||
            headers?.get(name.replace('-reset', '-remaining')) === '0')
      )
      .map(([name, value]) => waitFromHeader(name, value, Date.now()) ?? 0);
    const rateLimited = status === 429;
    const attemptLimit = rateLimited ? MAX_RATE_LIMIT_ATTEMPTS : MAX_ATTEMPTS;
    const baseMs = rateLimited && !waits.some(ms => ms > 0) ? RATE_LIMIT_BACKOFF_BASE_MS : BACKOFF_BASE_MS;
    const backoffMs = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** (attempt - 1) * (1 + Math.random()));
    const delayMs = Math.max(backoffMs, ...waits);
    if (retryable && attempt < attemptLimit && Date.now() + delayMs < deadline) {
      report({ ...diagnostic, event: 'retry', delayMs });
      await new Promise(resolve => setTimeout(resolve, delayMs));
      continue;
    }
    if (retryable && attempt < attemptLimit && Date.now() + delayMs >= deadline) diagnostic.reason = 'deadline';
    report(diagnostic);
    throw new Error(`${provider} API${status ? ` ${status}` : ''}: ${diagnostic.reason} (attempt ${attempt})`);
  }
  throw new Error(`${provider} API: retry limit`);
}
