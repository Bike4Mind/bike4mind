import { assertBaseUrl } from './client';
import { B4mApiError } from './errors';

// Documented TTL of an exchanged key when the response omits `expires_in`.
const DEFAULT_TTL_SECONDS = 900;
const DEFAULT_SCOPE = 'ai:generate';

export interface ExchangeIdTokenOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  idToken: string;
  /** Space-separated; omitted from the request when undefined (the server defaults to `ai:generate`). */
  scope?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface ExchangedKey {
  apiKey: string;
  expiresAt: Date;
  scope: string;
}

/**
 * Exchange a signed-in user's OIDC ID token for a short-lived, per-user API key (`POST /api/oauth/ai-token`).
 *
 * Server only: the call needs the client secret. Each exchange revokes the user's previous key for this app, so
 * cache the result per user and re-mint shortly before `expiresAt`. A non-2xx response throws `B4mApiError`, with
 * `errorCode` set from the OAuth `error` field.
 */
export async function exchangeIdToken(options: ExchangeIdTokenOptions): Promise<ExchangedKey> {
  assertBaseUrl(options.baseUrl, 'exchangeIdToken');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const requestedAt = Date.now();
  const response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, '')}/api/oauth/ai-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      id_token: options.idToken,
      ...(options.scope !== undefined && { scope: options.scope }),
    }),
    signal: options.signal,
  });
  if (!response.ok) throw await B4mApiError.fromResponse(response);

  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.api_key !== 'string') throw new Error('exchangeIdToken: response has no api_key');
  const ttl = typeof body.expires_in === 'number' ? body.expires_in : DEFAULT_TTL_SECONDS;
  return {
    apiKey: body.api_key,
    expiresAt: new Date(requestedAt + ttl * 1000),
    scope: typeof body.scope === 'string' ? body.scope : (options.scope ?? DEFAULT_SCOPE),
  };
}
