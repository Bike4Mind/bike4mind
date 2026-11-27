import { resolveClientSurface, type ISessionOrigin } from '@bike4mind/common';

interface OriginRequest {
  apiKeyInfo?: { keyId: string };
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Returns the origin to stamp on a session this request creates: 'api' (with the key id) when the
 * request authenticated with an API key, 'cli' or 'desktop' for a JWT request from that first-party
 * client (resolveClientSurface), 'web' otherwise. The client header is caller-controlled, which is
 * acceptable for a display label: at worst a caller mislabels their own session. The API-key arm
 * is not spoofable.
 */
export function resolveSessionOrigin(req: OriginRequest): ISessionOrigin {
  if (req.apiKeyInfo?.keyId) return { channel: 'api', apiKeyId: req.apiKeyInfo.keyId };
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    headers[name] = Array.isArray(value) ? value[0] : value;
  }
  const { surface } = resolveClientSurface(headers, { delegatedCredential: false });
  return { channel: surface === 'cli' || surface === 'desktop' ? surface : 'web' };
}
