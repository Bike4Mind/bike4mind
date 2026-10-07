import axios, { isAxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';
import type { RefreshTokenResponse } from './DeviceFlowClient';
import type { AuthLogger, TokenStore } from './tokens';

/**
 * Thrown by the response interceptor only when the session is DEFINITIVELY revoked - the
 * refresh token was rejected (400/401 invalid_grant), or a request still 401s after a
 * successful refresh. A transient refresh outage (5xx / network / timeout) throws a plain
 * Error instead, so callers that must distinguish "log out" from "retry" (e.g.
 * checkSessionValid / a WS reconnect loop) can key on the type. The human-readable
 * message is preserved on both paths so existing `error.message.includes(...)` callers are
 * unaffected.
 */
export class SessionRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionRevokedError';
  }
}

/**
 * 401 with no credential at all (no API key, no stored tokens): a config gap, not an expiry.
 * Not a SessionRevokedError, so checkSessionValid still reports "not revoked". The host's message
 * should keep `Authentication failed` for string-matching callers.
 */
export class NotAuthenticatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

/** The one thing the refresh-on-401 path needs from an OAuth client. */
export interface RefreshingOAuthClient {
  refreshToken(refreshToken: string): Promise<RefreshTokenResponse>;
}

/**
 * User-facing re-authentication prompts. They name a host-specific action ("run `b4m login`",
 * "open Settings"), so the host supplies them rather than this package inventing wording.
 */
export interface ReauthMessages {
  /** A refresh attempt failed and the stored access token is already expired. */
  refreshFailed: string;
  /** A request still 401d after a successful refresh. */
  stillUnauthorized: string;
  /** A request 401d and there are no stored tokens to refresh. */
  notLoggedIn?: string;
}

export interface AuthenticatedApiClientOptions {
  baseUrl: string;
  tokenStore: TokenStore;
  oauthClient: RefreshingOAuthClient;
  logger: AuthLogger;
  reauthMessages: ReauthMessages;
  /** Per-request timeout in ms. Omitted leaves axios unbounded. */
  timeoutMs?: number;
  /** Extra default headers, e.g. a client's User-Agent. Merged over `Content-Type`. */
  headers?: Record<string, string>;
  /**
   * When set, requests authenticate with this instance API key via the `x-api-key` header
   * and the OAuth-JWT path (Bearer injection + refresh-on-401) is bypassed entirely.
   */
  apiKey?: string;
  /**
   * A 401 whose body this returns true for is passed through untouched, including on the
   * post-refresh retry: the B4M credential was accepted, so refreshing cannot fix it (e.g. a
   * missing AI-provider key).
   */
  isPassThrough401?: (data: unknown) => boolean;
}

/**
 * Authenticated API client for B4M services.
 * Injects access tokens from the supplied {@link TokenStore} and refreshes them on a 401.
 */
export class AuthenticatedApiClient {
  private client: AxiosInstance;
  private tokenStore: TokenStore;
  private oauthClient: RefreshingOAuthClient;
  private logger: AuthLogger;
  private apiKey?: string;
  private isPassThrough401?: (data: unknown) => boolean;

  constructor(options: AuthenticatedApiClientOptions) {
    this.tokenStore = options.tokenStore;
    this.oauthClient = options.oauthClient;
    this.logger = options.logger;
    this.apiKey = options.apiKey;
    this.isPassThrough401 = options.isPassThrough401;
    const {
      refreshFailed,
      stillUnauthorized,
      notLoggedIn = 'Authentication failed: not logged in.',
    } = options.reauthMessages;

    this.client = axios.create({
      baseURL: options.baseUrl,
      timeout: options.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    // Add request interceptor to inject credentials. An API key takes precedence and
    // never mixes with a stored JWT - the two auth schemes are mutually exclusive.
    this.client.interceptors.request.use(
      async config => {
        if (this.apiKey) {
          config.headers['x-api-key'] = this.apiKey;
          return config;
        }

        const tokens = await this.tokenStore.getAuthTokens();

        if (tokens) {
          config.headers.Authorization = `Bearer ${tokens.accessToken}`;
        }

        return config;
      },
      error => Promise.reject(error)
    );

    // Add response interceptor for token refresh
    this.client.interceptors.response.use(
      response => response,
      async error => {
        const originalRequest = error.config;

        // Log HTTP errors (debug level - these are handled by the retry logic below)
        if (error.response?.status === 401) {
          this.logger.debug('AUTH: Received 401 Unauthorized');
        } else if (error.response?.status === 403) {
          this.logger.error('403 Forbidden', error);
        }

        // API-key auth has no refresh token to rotate, so a 401 is terminal - skip
        // the JWT refresh dance and let the caller surface it.
        if (this.apiKey) {
          return Promise.reject(error);
        }

        if (error.response?.status === 401 && this.isPassThrough401?.(error.response.data)) {
          return Promise.reject(error);
        }

        // If 401 and we haven't retried yet, try to refresh token
        if (error.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true;

          // Outside the try: the catch below would rewrite a no-token throw as refreshFailed.
          const tokens = await this.tokenStore.getAuthTokens();

          if (!tokens) {
            throw new NotAuthenticatedError(notLoggedIn);
          }

          try {
            // Skip refresh while the stored access token has not expired yet: a 401 against a
            // token that is still inside its own lifetime is far more likely a transient server
            // error than an auth failure, and refreshing would spend a rotation for nothing.
            //
            // This reads `expiresAt` directly rather than reconstructing an issue time by
            // subtracting an assumed lifetime from it. The old form subtracted a hardcoded 7 days,
            // which stopped being true when access tokens became short-lived - it reported every
            // token as ~7 days old and the branch never fired.
            //
            // NOTE: this means a tokenVersion kill-switch bump is not detected as a revocation
            // until the token actually expires (checkSessionValid reports it valid until then).
            // REST calls still 401 in the meantime, so it is a bounded no-teardown delay, not
            // retained access.
            if (new Date(tokens.expiresAt).getTime() > Date.now()) {
              this.logger.debug('AUTH: Access token has not expired, skipping refresh - 401 is likely transient');
              return Promise.reject(error);
            }

            // Attempt to refresh the access token
            this.logger.debug('AUTH: Attempting token refresh');
            const newTokens = await this.oauthClient.refreshToken(tokens.refreshToken);
            this.logger.debug('AUTH: Token refresh successful');

            // Calculate new expiry time
            const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000).toISOString();

            // Store new tokens. `refresh_token` is absent when the server did not rotate the chain
            // (RFC 6749 s6) - keep the one we presented rather than persisting undefined, which
            // would erase the credential and force a re-login on the next call.
            await this.tokenStore.setAuthTokens({
              accessToken: newTokens.access_token,
              refreshToken: newTokens.refresh_token ?? tokens.refreshToken,
              expiresAt,
              userId: tokens.userId, // Preserve userId
            });

            // Update the original request with new token
            originalRequest.headers.Authorization = `Bearer ${newTokens.access_token}`;

            // Retry original request with new token
            this.logger.debug('AUTH: Retrying request with new token');
            return this.client(originalRequest);
          } catch (refreshError) {
            const refreshMsg = refreshError instanceof Error ? refreshError.message : 'Unknown error';
            this.logger.warn(`AUTH: Token refresh failed: ${refreshMsg}`);

            // Only clear tokens if the access token is actually expired
            const tokens = await this.tokenStore.getAuthTokens();
            if (tokens && new Date(tokens.expiresAt) <= new Date()) {
              await this.tokenStore.clearAuthTokens();
            }

            // A 400/401 from the refresh endpoint means the refresh token was rejected =
            // genuine revocation (SessionRevokedError). A 5xx / network / timeout is a transient
            // outage - throw a plain Error (same message, so string-matching callers are
            // unaffected) so revoke-vs-transient consumers keep retrying instead of tearing down.
            const refreshStatus = isAxiosError(refreshError) ? refreshError.response?.status : undefined;
            if (refreshStatus === 400 || refreshStatus === 401) {
              throw new SessionRevokedError(refreshFailed);
            }
            throw new Error(refreshFailed);
          }
        }

        // If we already retried and still got 401, auth is invalid - a 401 that survives a
        // successful refresh is a definitive revocation.
        if (error.response?.status === 401 && originalRequest._retry) {
          this.logger.debug('AUTH: Token refresh retry failed');
          // Only clear tokens if genuinely expired
          const tokens = await this.tokenStore.getAuthTokens();
          if (tokens && new Date(tokens.expiresAt) <= new Date()) {
            await this.tokenStore.clearAuthTokens();
          }
          throw new SessionRevokedError(stillUnauthorized);
        }

        return Promise.reject(error);
      }
    );
  }

  /**
   * Make a GET request
   */
  async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.client.get<T>(url, config);
    return response.data;
  }

  /**
   * Make a POST request
   */
  async post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    this.logger.debug(`[ApiClient] POST ${this.client.defaults.baseURL}${url}`);
    this.logger.debug(`[ApiClient] Request body: ${JSON.stringify(data)}`);
    const response = await this.client.post<T>(url, data, config);
    this.logger.debug(`[ApiClient] Response status: ${response.status}`);
    return response.data;
  }

  /**
   * Make a PUT request
   */
  async put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.client.put<T>(url, data, config);
    return response.data;
  }

  /**
   * Make a DELETE request
   */
  async delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.client.delete<T>(url, config);
    return response.data;
  }

  /**
   * Get the underlying axios instance for advanced use cases (e.g., streaming)
   */
  getAxiosInstance(): AxiosInstance {
    return this.client;
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    return this.tokenStore.isAuthenticated();
  }

  /**
   * Get current user information
   */
  async getCurrentUser(): Promise<{ id: string; email?: string; displayName?: string } | null> {
    try {
      const tokens = await this.tokenStore.getAuthTokens();
      if (!tokens) return null;

      // TODO: Implement /api/me endpoint to get user info
      // For now, return basic info from tokens
      return {
        id: tokens.userId,
      };
    } catch {
      return null;
    }
  }

  /**
   * Verifies the session is still valid via a cheap authed GET. The response interceptor
   * above already attempts a token refresh and retries on 401, so a resolved call means the
   * session is valid (fresh or transparently refreshed). Returns false ONLY on a
   * `SessionRevokedError` (the refresh token was rejected, or a 401 survived a refresh);
   * every other outcome - a transient refresh outage, a network blip, or the interceptor's
   * fresh-token 401 skip - is treated as transient and returns true, so callers keep
   * retrying rather than tearing down on a blip.
   *
   * Used by the CLI's WebSocketConnectionManager to distinguish "session revoked" from
   * "transient network issue" when a WS connect attempt fails to open - a WS close event
   * carries no HTTP status, so this is the only way to tell the two apart.
   */
  async checkSessionValid(): Promise<boolean> {
    try {
      await this.get('/api/identify');
      return true;
    } catch (err) {
      return !(err instanceof SessionRevokedError);
    }
  }
}
