import type { ISessionOrigin } from '@bike4mind/common';

/** The `X-B4M-Client` value the CLI's ApiClient sends (packages/cli/src/auth/ApiClient.ts). */
const CLI_CLIENT_PREFIX = 'b4m-cli/';

interface OriginRequest {
  apiKeyInfo?: { keyId: string };
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Returns the origin to stamp on a session this request creates: 'api' (with the key id) when the
 * request authenticated with an API key, 'cli' for a JWT request from the CLI, 'web' otherwise.
 * The client header is caller-controlled, which is acceptable for a display label: at worst a
 * caller mislabels their own session. The API-key arm is not spoofable.
 */
export function resolveSessionOrigin(req: OriginRequest): ISessionOrigin {
  if (req.apiKeyInfo?.keyId) return { channel: 'api', apiKeyId: req.apiKeyInfo.keyId };
  const client = req.headers?.['x-b4m-client'];
  const clientValue = Array.isArray(client) ? client[0] : client;
  if (clientValue?.startsWith(CLI_CLIENT_PREFIX)) return { channel: 'cli' };
  return { channel: 'web' };
}
