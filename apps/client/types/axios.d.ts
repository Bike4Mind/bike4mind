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
    /**
     * Set when a 401 was retried purely because the token it presented had already been replaced
     * (another request, or another tab). Deliberately NOT counted in `_retryCount`: that budget
     * means "we refreshed and the new token was still rejected", which is the signal to tear the
     * session down. A swapped-in token carries no such guarantee - sibling tabs expire together,
     * so it may be just as stale - and spending the budget on it would tear down a healthy session
     * without ever refreshing.
     */
    _staleTokenRetried?: boolean;
  }
}
