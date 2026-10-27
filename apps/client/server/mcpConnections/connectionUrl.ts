import { BadRequestError, toMcpDisplayUrl } from '@bike4mind/common';
import { RemoteMcpInvalidUrlError, validateRemoteMcpUrl } from '@bike4mind/mcp/remote';
import { encryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import type { RemoteMcpNetworkOptions } from './customMcpAccess';

export interface PreparedConnectionUrl {
  /** Normalized URL; stored only as `urlEnc`, never returned to the client. */
  url: string;
  urlEnc: string;
  displayUrl: string;
  /** Lowercased hostname without the port (what host policy matches). */
  urlHost: string;
}

/**
 * Validates a user-supplied server URL with the deployment's own hosts refused (and, on self-host,
 * the admin's private CIDRs and http opt-in), then derives the stored fields the way c2 documents
 * them. Throws a 400 carrying the rejection reason.
 */
export function prepareConnectionUrl(raw: string, network: RemoteMcpNetworkOptions): PreparedConnectionUrl {
  let url: URL;
  try {
    url = validateRemoteMcpUrl(raw, network);
  } catch (error) {
    if (error instanceof RemoteMcpInvalidUrlError) {
      throw new BadRequestError(error.message, { code: 'invalid_url', reason: error.reason });
    }
    throw error;
  }
  const normalized = url.toString();
  const urlEnc = encryptToken(normalized);
  if (!urlEnc) throw new Error('URL encryption returned nothing');
  return {
    url: normalized,
    urlEnc,
    displayUrl: toMcpDisplayUrl(normalized),
    urlHost: url.hostname.toLowerCase(),
  };
}
