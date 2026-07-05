import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { ConfigStore } from '../storage/ConfigStore';
import { OAuthClient } from './OAuthClient';
import { logger } from '../utils/Logger';
import packageJson from '../../package.json';

const USER_AGENT = `b4m-cli/${packageJson.version}`;

/**
 * Authenticated API client for B4M services
 * Automatically injects access tokens from ConfigStore
 */
export class ApiClient {
  private client: AxiosInstance;
  private configStore: ConfigStore;
  private oauthClient: OAuthClient;

  constructor(baseURL: string = 'http://localhost:3000', configStore?: ConfigStore) {
    this.configStore = configStore || new ConfigStore();
    this.oauthClient = new OAuthClient(baseURL);

    this.client = axios.create({
      baseURL,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-B4M-Client': USER_AGENT,
      },
    });

    // Add request interceptor to inject access token
    this.client.interceptors.request.use(
      async config => {
        const tokens = await this.configStore.getAuthTokens();

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
          logger.debug('AUTH: Received 401 Unauthorized');
        } else if (error.response?.status === 403) {
          logger.error('403 Forbidden', error);
        }

        // If 401 and we haven't retried yet, try to refresh token
        if (error.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true;

          try {
            const tokens = await this.configStore.getAuthTokens();

            if (!tokens) {
              throw new Error('Not authenticated');
            }

            // Skip refresh if the access token is still fresh (issued within the last hour).
            // A 401 with a fresh token is likely a transient server error, not an auth issue.
            const tokenAge = Date.now() - (new Date(tokens.expiresAt).getTime() - 7 * 24 * 60 * 60 * 1000);
            const ONE_HOUR = 60 * 60 * 1000;
            if (tokenAge < ONE_HOUR) {
              logger.debug('AUTH: Access token is fresh, skipping refresh — 401 is likely transient');
              return Promise.reject(error);
            }

            // Attempt to refresh the access token
            logger.debug('AUTH: Attempting token refresh');
            const newTokens = await this.oauthClient.refreshToken(tokens.refreshToken);
            logger.debug('AUTH: Token refresh successful');

            // Calculate new expiry time
            const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000).toISOString();

            // Store new tokens
            await this.configStore.setAuthTokens({
              accessToken: newTokens.access_token,
              refreshToken: newTokens.refresh_token,
              expiresAt,
              userId: tokens.userId, // Preserve userId
            });

            // Update the original request with new token
            originalRequest.headers.Authorization = `Bearer ${newTokens.access_token}`;

            // Retry original request with new token
            logger.debug('AUTH: Retrying request with new token');
            return this.client(originalRequest);
          } catch (refreshError) {
            const refreshMsg = refreshError instanceof Error ? refreshError.message : 'Unknown error';
            logger.warn(`AUTH: Token refresh failed: ${refreshMsg}`);

            // Only clear tokens if the access token is actually expired
            const tokens = await this.configStore.getAuthTokens();
            if (tokens && new Date(tokens.expiresAt) <= new Date()) {
              await this.configStore.clearAuthTokens();
            }

            throw new Error('Authentication expired. Please run `b4m login` again.');
          }
        }

        // If we already retried and still got 401, auth is invalid
        if (error.response?.status === 401 && originalRequest._retry) {
          logger.debug('AUTH: Token refresh retry failed');
          // Only clear tokens if genuinely expired
          const tokens = await this.configStore.getAuthTokens();
          if (tokens && new Date(tokens.expiresAt) <= new Date()) {
            await this.configStore.clearAuthTokens();
          }
          throw new Error('Authentication failed. Please run /login to authenticate.');
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
    logger.debug(`[ApiClient] POST ${this.client.defaults.baseURL}${url}`);
    logger.debug(`[ApiClient] Request body: ${JSON.stringify(data)}`);
    const response = await this.client.post<T>(url, data, config);
    logger.debug(`[ApiClient] Response status: ${response.status}`);
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
    return this.configStore.isAuthenticated();
  }

  /**
   * Get current user information
   */
  async getCurrentUser(): Promise<{ id: string; email?: string; displayName?: string } | null> {
    try {
      const tokens = await this.configStore.getAuthTokens();
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
}
