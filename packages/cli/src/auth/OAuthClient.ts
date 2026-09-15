import axios, { type AxiosInstance } from 'axios';

export interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * A refresh-grant response. Unlike the authorization-code and device grants, `refresh_token` is
 * OPTIONAL here (RFC 6749 s6): the server omits it when this refresh did not rotate the chain, and
 * an absent value means "keep the token you already have" - never "you no longer have one".
 */
export type RefreshTokenResponse = Omit<TokenResponse, 'refresh_token'> & { refresh_token?: string };

export interface TokenError {
  error: string;
  error_description: string;
}

/**
 * OAuth 2.0 Device Authorization Flow client
 * Implements RFC 8628 for CLI authentication
 */
export class OAuthClient {
  private apiClient: AxiosInstance;
  private readonly clientId = 'b4m-cli';

  constructor(baseURL: string = 'http://localhost:3000') {
    this.apiClient = axios.create({
      baseURL,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Initiate device authorization flow
   * Returns device code, user code, and verification URL
   */
  async initiateDeviceFlow(): Promise<DeviceFlowResponse> {
    const response = await this.apiClient.post<DeviceFlowResponse>('/api/oauth/device/initiate', {
      client_id: this.clientId,
    });

    return response.data;
  }

  /**
   * Poll for access token
   * Returns token response if approved, or throws error with status
   */
  async pollForToken(deviceCode: string): Promise<TokenResponse> {
    try {
      const response = await this.apiClient.post<TokenResponse | TokenError>(
        '/api/oauth/device/token',
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: this.clientId,
        },
        {
          validateStatus: () => true, // Don't throw on any status code
        }
      );

      // Check if response is an error
      if ('error' in response.data) {
        throw new Error(response.data.error);
      }

      return response.data as TokenResponse;
    } catch (error) {
      // Handle axios errors
      if (axios.isAxiosError(error) && error.response?.data?.error) {
        throw new Error(error.response.data.error);
      }
      throw error;
    }
  }

  /**
   * Wait for user authorization with automatic polling
   * Implements exponential backoff and respects server's interval
   */
  async waitForAuthorization(
    deviceCode: string,
    interval: number,
    onStatus?: (status: string) => void
  ): Promise<TokenResponse> {
    let pollInterval = interval * 1000; // Convert to milliseconds
    const maxInterval = 30000; // Max 30 seconds

    // Initial status message
    onStatus?.('Waiting for user authorization...');

    // Wait before first poll (respects server's interval)
    await this.sleep(pollInterval);

    while (true) {
      try {
        const token = await this.pollForToken(deviceCode);
        return token;
      } catch (error) {
        if (error instanceof Error) {
          const errorMessage = error.message;

          if (errorMessage === 'authorization_pending') {
            // Still waiting for user approval
            onStatus?.('Waiting for user authorization...');
            await this.sleep(pollInterval);
            continue;
          }

          if (errorMessage === 'slow_down') {
            // Server asked us to slow down
            pollInterval = Math.min(pollInterval + 5000, maxInterval);
            onStatus?.('Slowing down polling...');
            await this.sleep(pollInterval);
            continue;
          }

          if (errorMessage === 'access_denied') {
            throw new Error('User denied the authorization request');
          }

          if (errorMessage === 'expired_token') {
            throw new Error('Authorization code has expired');
          }

          // Unknown error
          throw error;
        }

        throw error;
      }
    }
  }

  /**
   * Refresh an expired access token
   */
  async refreshToken(refreshToken: string): Promise<RefreshTokenResponse> {
    const response = await this.apiClient.post<RefreshTokenResponse>('/api/oauth/refresh', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
    });

    return response.data;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
