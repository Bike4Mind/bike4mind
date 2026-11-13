import { createRemoteMcpOAuthFetch } from '@bike4mind/mcp/remote';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { RemoteMcpNetworkOptions } from '../customMcpAccess';

/** Runs `fn` with the SSRF-pinned fetch, or with `override` (tests) which the caller owns. */
export async function withOAuthFetch<T>(
  network: RemoteMcpNetworkOptions,
  override: FetchLike | undefined,
  fn: (fetchFn: FetchLike) => Promise<T>
): Promise<T> {
  if (override) return fn(override);
  const pinned = createRemoteMcpOAuthFetch(network);
  try {
    return await fn(pinned);
  } finally {
    await pinned.close();
  }
}
