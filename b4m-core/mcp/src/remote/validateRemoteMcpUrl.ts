import { isIP } from 'net';
import {
  buildPrivateAddressAdmission,
  isNonPublicHostname,
  isPrivateOrInternalHostname,
} from '@bike4mind/fab-pipeline/ssrf';
import { RemoteMcpInvalidUrlError } from './errors';

export interface ValidateRemoteMcpUrlOptions {
  /** Permit plain http (self-host opt-in). */
  allowHttp?: boolean;
  /**
   * Self-host opt-in CIDRs. When non-empty, IP literals inside these ranges and private-suffix hostnames are
   * accepted here; the connect-time pin in `pinnedFetch` still enforces the ranges.
   */
  allowPrivateCidrs?: string[];
  /** The deployment's own hosts (APP_URL, CDN). Each entry also covers its subdomains. Hostnames or URLs. */
  ownHosts?: string[];
}

const MAX_URL_LENGTH = 2048;
const METADATA_HOSTNAMES = new Set(['instance-data', 'metadata', 'metadata.google.internal', 'metadata.internal']);

function isLocalhostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

function normalizeOwnHost(entry: string): string | undefined {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

/**
 * Validates a user-supplied remote MCP server URL and returns it normalized (lowercased host, no trailing
 * dot, no fragment). Throws `RemoteMcpInvalidUrlError` with a `reason` on rejection.
 *
 * This is the early, explainable check. It is not what stops DNS rebinding: that is the connect-time pin
 * in `pinnedFetch` (`@bike4mind/fab-pipeline/ssrf`), which every request made by `RemoteMcpClient` goes through.
 */
export function validateRemoteMcpUrl(input: string, options: ValidateRemoteMcpUrlOptions = {}): URL {
  const { allowHttp = false, allowPrivateCidrs = [], ownHosts = [] } = options;
  const selfHostPrivate = allowPrivateCidrs.length > 0;

  if (input.length > MAX_URL_LENGTH) {
    throw new RemoteMcpInvalidUrlError('malformed', `URL is longer than ${MAX_URL_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new RemoteMcpInvalidUrlError('malformed', 'URL is not valid');
  }

  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new RemoteMcpInvalidUrlError('scheme', allowHttp ? 'URL must use http or https' : 'URL must use https');
  }
  if (url.username || url.password) {
    throw new RemoteMcpInvalidUrlError('userinfo', 'URL must not contain a username or password');
  }

  url.hash = '';
  // Strip every trailing dot: one hand-typed dot is the FQDN root and resolves to the same host, so
  // leaving a second one would let `app.example.com..` dodge the `own_host` and suffix rules below.
  url.hostname = url.hostname.replace(/\.+$/, '');
  // WHATWG URL already lowercases the host and rewrites decimal, octal and hex IPv4 spellings
  // (`2130706433`, `0x7f.1`, `0177.0.0.1`) to dotted form, so one isIP check covers every literal form.
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (!host) {
    throw new RemoteMcpInvalidUrlError('malformed', 'URL has no host');
  }

  const family = isIP(host);
  if (family !== 0) {
    const admitted = selfHostPrivate && buildPrivateAddressAdmission({ allowPrivateCidrs })(host, family);
    if (!admitted) {
      throw new RemoteMcpInvalidUrlError('ip_literal', 'URL must use a hostname, not an IP address');
    }
  } else if (isLocalhostName(host) || METADATA_HOSTNAMES.has(host)) {
    throw new RemoteMcpInvalidUrlError('internal_hostname', 'URL points to a local or metadata host');
  } else if (!selfHostPrivate && (isPrivateOrInternalHostname(host) || isNonPublicHostname(host))) {
    throw new RemoteMcpInvalidUrlError('internal_hostname', 'URL points to a private or internal hostname');
  }

  for (const own of ownHosts.map(normalizeOwnHost)) {
    if (own && (host === own || host.endsWith(`.${own}`))) {
      throw new RemoteMcpInvalidUrlError('own_host', 'URL points to this deployment');
    }
  }

  // An empty port is the scheme default (443, or 80 under allowHttp).
  if (url.port !== '' && url.port !== '443' && Number(url.port) < 1024) {
    throw new RemoteMcpInvalidUrlError('port', 'Ports below 1024 other than 443 are not allowed');
  }

  return url;
}
