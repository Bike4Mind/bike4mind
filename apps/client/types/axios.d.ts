// Extend Axios types to include custom configuration options
import 'axios';

declare module 'axios' {
  export interface AxiosRequestConfig {
    /**
     * If true, prevents the automatic token refresh retry on 401 responses.
     * Use this for endpoints that may return 401 for reasons other than expired auth tokens
     * (e.g., missing API keys, invalid credentials, etc.) to prevent infinite retry loops.
     */
    skipAuthRefresh?: boolean;
    /** Tracks how many times this request has been retried after a token refresh. */
    _retryCount?: number;
  }
}
