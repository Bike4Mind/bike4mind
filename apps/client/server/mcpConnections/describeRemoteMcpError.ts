import { HTTPError, type IMcpConnectionDocument } from '@bike4mind/common';
import { RemoteMcpError, RemoteMcpUpstreamError } from '@bike4mind/mcp/remote';

/** Short, fixed text per failure: the server's own error text is never reflected back. */
export function describeRemoteMcpError(
  error: RemoteMcpError,
  authKind: IMcpConnectionDocument['auth']['kind']
): string {
  switch (error.code) {
    case 'invalid_url':
      return error.message;
    case 'ssrf_blocked':
      return 'The server address resolves to a private or blocked network';
    case 'timeout':
      return 'The server did not answer in time';
    case 'auth_required':
      return authKind === 'api_key' ? 'The server rejected the API key' : 'The server requires sign-in';
    case 'auth_failed':
      return 'The server refused the credentials';
    case 'protocol':
      return 'The server did not respond as an MCP server';
    case 'size_cap':
      return 'The server response was too large';
    case 'upstream_5xx':
      return error instanceof RemoteMcpUpstreamError
        ? `The server returned an error (HTTP ${error.status})`
        : 'The server returned an error';
  }
}

/**
 * Text for a failed custom connector call that is safe to show next to an approval card: protocol
 * errors map to fixed text, `HTTPError`s are this app's own refusals (policy, rate limit, breaker),
 * and anything else (which may carry remote or internal detail) collapses to a generic line.
 */
export function describeCustomCallFailure(error: unknown): string {
  if (error instanceof RemoteMcpError) return describeRemoteMcpError(error, 'none');
  if (error instanceof HTTPError && error.message) return error.message;
  return 'Action failed';
}
