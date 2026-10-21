import { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { isAxiosError, type AxiosResponse } from 'axios';
import { Readable } from 'node:stream';
import { isProviderKeyFailure } from './providerKeyFailure';
import { ConfigStore } from '../storage/ConfigStore';
import { OAuthClient } from './OAuthClient';
import { logger } from '../utils/Logger';
import packageJson from '../../package.json';

export { NotAuthenticatedError, SessionRevokedError } from '@bike4mind/client-auth';

const USER_AGENT = `b4m-cli/${packageJson.version}`;

/**
 * Per-request timeout. Generous by design: a waited chat (POST /api/chat with wait:true)
 * runs a full server-side quest, so the bound only exists to stop a hung backend from
 * wedging a caller forever, not to cap a normal long quest. Override with B4M_API_TIMEOUT_MS
 * (0 disables the timeout entirely).
 */
export const DEFAULT_API_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function resolveTimeoutMs(): number {
  const raw = process.env.B4M_API_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_API_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_API_TIMEOUT_MS;
}

/**
 * The shared authenticated client, wired to the CLI's storage, logger and branding.
 */
export class ApiClient extends AuthenticatedApiClient {
  /**
   * @param apiKey - When set, requests authenticate with this instance API key via
   *   the `x-api-key` header and the OAuth-JWT path (Bearer injection + refresh-on-401)
   *   is bypassed entirely. Omit to keep the default stored-JWT behavior unchanged.
   */
  constructor(baseURL: string = 'http://localhost:3000', configStore?: ConfigStore, apiKey?: string) {
    super({
      baseUrl: baseURL,
      tokenStore: configStore || new ConfigStore(),
      oauthClient: new OAuthClient(baseURL),
      logger,
      apiKey,
      timeoutMs: resolveTimeoutMs(),
      headers: {
        'User-Agent': USER_AGENT,
        'X-B4M-Client': USER_AGENT,
      },
      reauthMessages: {
        refreshFailed: 'Authentication expired. Please run `b4m login` again.',
        stillUnauthorized: 'Authentication failed. Please run /login to authenticate.',
        notLoggedIn: 'Authentication failed: not logged in. Please run `b4m login` to authenticate.',
      },
      isPassThrough401: isProviderKeyFailure,
    });
  }

  get baseURL(): string {
    return this.getAxiosInstance().defaults.baseURL ?? '';
  }

  /**
   * A `fetch` over the axios instance, handed to `@bike4mind/sdk` so SDK calls get the same credential
   * injection, timeout and refresh-on-401 as get/post. An HTTP error status resolves as a Response (the SDK
   * maps it); auth, network and timeout failures still throw the interceptor / axios errors. A request that
   * accepts `text/event-stream` streams its body; anything else is buffered.
   */
  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init.headers));
    try {
      const response = await this.getAxiosInstance().request({
        url: input instanceof Request ? input.url : String(input),
        method: init.method ?? 'GET',
        headers,
        data: init.body ?? undefined,
        signal: init.signal ?? undefined,
        responseType: /text\/event-stream/i.test(headers.accept ?? '') ? 'stream' : 'arraybuffer',
        ...(init.redirect && init.redirect !== 'follow' ? { maxRedirects: 0 } : {}),
      });
      return toFetchResponse(response);
    } catch (error) {
      if (isAxiosError(error) && error.response) return toFetchResponse(error.response);
      throw error;
    }
  };
}

function toFetchResponse(response: AxiosResponse): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined && value !== null)
      headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }
  const nullBody = [101, 204, 205, 304].includes(response.status);
  const body: ConstructorParameters<typeof Response>[0] = nullBody
    ? null
    : response.data instanceof Readable
      ? (Readable.toWeb(response.data) as ReadableStream<Uint8Array>)
      : response.data;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
