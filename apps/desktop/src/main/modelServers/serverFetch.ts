import dns, { type LookupAddress, type LookupAllOptions, type LookupOneOptions } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { FetchLike } from '@bike4mind/local-models';
import { scopeOfIp, transportVerdict } from './addressPolicy';

/** Refused before anything was sent: wrong origin, or a transport rule (see addressPolicy). */
export class ServerTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerTransportError';
  }
}

/** The server answered with a redirect. Never followed, so a credential cannot be carried anywhere else. */
export class ServerRedirectError extends Error {
  constructor(
    message: string,
    readonly crossOrigin: boolean
  ) {
    super(message);
    this.name = 'ServerRedirectError';
  }
}

export interface ServerEndpoint {
  /** `scheme://host:port` every request must target. */
  origin: string;
  /** Shown in errors. */
  label: string;
  /** Read per request so a credential change applies at once. Null for none. */
  credentialHeaders(): Record<string, string> | null;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type Lookup = (hostname: string, options: LookupOneOptions | LookupAllOptions, callback: LookupCallback) => void;

export interface ServerFetchDeps {
  /** Defaults to `dns.lookup`, read at call time. */
  lookup?: Lookup;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NO_BODY = new Set([204, 205, 304]);

/**
 * Fetch for one saved server, on Node's http/https rather than Chromium's network stack: certificates
 * are checked against the system and NODE_EXTRA_CA_CERTS roots, there is no header deadline (a
 * CPU-only server can take minutes to prefill), and the address a name resolves to is checked against
 * the transport rules before the socket opens, so no byte of a credential leaves for a refused address.
 *
 * Credentials are added here and nowhere else, only to requests for `endpoint.origin`, and no
 * redirect is followed. Connection failures reject with `TypeError('fetch failed', { cause })` like fetch.
 */
export function createServerFetch(endpoint: ServerEndpoint, deps: ServerFetchDeps = {}): FetchLike {
  return async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin !== endpoint.origin) {
      throw new ServerTransportError(`Desktop only sends ${endpoint.label}'s requests to its own address.`);
    }
    const credentials = endpoint.credentialHeaders();
    const headers: Record<string, string> = { ...plainHeaders(init.headers), ...(credentials ?? {}) };
    const hasCredentials = !!credentials && Object.keys(credentials).length > 0;
    const protocol = url.protocol;
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    if (isIP(host)) {
      const verdict = transportVerdict(protocol, scopeOfIp(host) ?? 'public', hasCredentials);
      if (!verdict.ok) throw new ServerTransportError(verdict.reason);
    }
    const body = requestBody(init.body);
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));

    const lookup: Lookup = (hostname, options, callback) => {
      (deps.lookup ?? (dns.lookup as unknown as Lookup))(hostname, options, (err, address, family) => {
        if (err) return callback(err, address, family);
        const resolved = Array.isArray(address) ? address : [{ address, family: family ?? 4 }];
        for (const entry of resolved) {
          const verdict = transportVerdict(protocol, scopeOfIp(entry.address) ?? 'public', hasCredentials);
          if (!verdict.ok) return callback(new ServerTransportError(verdict.reason), address, family);
        }
        callback(null, address, family);
      });
    };

    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const transport = protocol === 'https:' ? https : http;
      const request = transport.request(url, {
        method: init.method ?? 'GET',
        headers,
        lookup: lookup as never,
        // The shared agent pools sockets by host and port, so a reused one would skip the lookup check.
        agent: false,
        ...(init.signal ? { signal: init.signal } : {}),
      });
      request.once('response', resolve);
      request.once('error', error => reject(wrapError(error, init.signal, endpoint.label)));
      request.end(body);
    });

    const status = response.statusCode ?? 0;
    if (status < 200 || status > 599) {
      response.destroy();
      throw new TypeError(`${endpoint.label} answered with an invalid HTTP status (${status}).`);
    }
    if (REDIRECTS.has(status)) {
      response.resume();
      const location = response.headers.location;
      const target = location && URL.canParse(location, url.href) ? new URL(location, url) : null;
      const crossOrigin = !target || target.origin !== endpoint.origin;
      throw new ServerRedirectError(
        crossOrigin
          ? `${endpoint.label} redirected to ${target?.origin ?? 'another address'}. Desktop does not follow redirects to another address, so its credentials stay with this server. Check the address.`
          : `${endpoint.label} answered with a redirect to ${target.pathname}. Check the address, including any path.`,
        crossOrigin
      );
    }
    const responseHeaders = new Headers();
    for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
      responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
    }
    const empty = NO_BODY.has(status) || init.method === 'HEAD';
    if (empty) response.resume();
    return new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
      status,
      statusText: response.statusMessage ?? '',
      headers: responseHeaders,
    });
  };
}

function plainHeaders(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

function requestBody(body: RequestInit['body']): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  throw new ServerTransportError('Model server requests must have a text body.');
}

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_NOT_YET_VALID',
]);

function wrapError(error: Error, signal: AbortSignal | null | undefined, label: string): unknown {
  if (signal?.aborted) return signal.reason ?? error;
  if (error instanceof ServerTransportError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && TLS_CODES.has(code)) {
    return new ServerTransportError(
      `The certificate of ${label} is not trusted (${code}). Use a certificate from a trusted authority, a local CA this computer trusts, or tailscale cert.`
    );
  }
  return new TypeError('fetch failed', { cause: error });
}
