/**
 * `fetch` for attacker-influenced URLs, pinned at CONNECT time.
 *
 * Every TCP connection - first request, redirect hops, and whatever the caller fetches next - resolves
 * through `createSsrfSafeLookup`, so the address that is validated is the address the socket dials. That
 * closes the DNS-rebinding residual documented on `safeFetch` in `apps/client/server/utils/ssrfProtection.ts`,
 * which cannot hook global fetch's resolver. Node skips `lookup` entirely for an IP-literal host, so literals
 * are judged per hop in `assertHopAllowed` instead.
 *
 * Also enforced: https only (unless `allowHttp`), a decoded-byte body cap, a whole-request timeout that
 * covers the body as well as the headers, and manual redirects capped and revalidated per hop.
 */

import { BlockList, isIP } from 'net';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  SSRF_BLOCKED_CODE,
  createSsrfSafeLookup,
  isNonPublicHostname,
  isPrivateIP,
  isPrivateOrInternalHostname,
} from './ssrfProtection';

export type PinnedFetchErrorCode =
  'ssrf_blocked' | 'scheme_blocked' | 'redirect_blocked' | 'too_many_redirects' | 'size_cap' | 'timeout';

export class PinnedFetchError extends Error {
  readonly code: PinnedFetchErrorCode;

  constructor(code: PinnedFetchErrorCode, message: string) {
    super(message);
    this.name = 'PinnedFetchError';
    this.code = code;
  }
}

export interface PinnedFetchOptions {
  /**
   * Self-host opt-in: private CIDRs (e.g. `10.20.0.0/16`) that may be dialled. Default deny. Loopback,
   * link-local and the cloud metadata addresses (including AWS IMDS over IPv6 and Alibaba's CGNAT
   * endpoint) are never admitted, whatever is listed.
   */
  allowPrivateCidrs?: string[];
  /** Permit plain http. Default false. */
  allowHttp?: boolean;
  /** Cap on DECODED body bytes per response (after content-encoding). Default 2 MiB. */
  maxBodyBytes?: number;
  /** Deadline for the whole request including the body, in ms. Default 30000. */
  timeoutMs?: number;
  /** Redirects followed when the caller's `redirect` is `follow`. Default 3. */
  maxRedirects?: number;
  /** Refuse a redirect whose origin differs from the original request's. */
  sameOriginRedirectsOnly?: boolean;
  /** Called once per refusal, before it is thrown or surfaced through a body stream. */
  onViolation?: (error: PinnedFetchError) => void;
  /**
   * TEST ONLY: admit loopback so a suite can reach a fixture server on 127.0.0.1. Throws unless running
   * under vitest, so no production config can turn it on.
   */
  testOnlyAllowLoopback?: boolean;
}

export type PinnedFetch = ((input: string | URL, init?: RequestInit) => Promise<Response>) & {
  /** Closes the connection pool. */
  close(): Promise<void>;
};

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const CROSS_ORIGIN_STRIPPED_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

function buildNeverAdmitted(): BlockList {
  const list = new BlockList();
  list.addSubnet('0.0.0.0', 8, 'ipv4');
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addSubnet('169.254.0.0', 16, 'ipv4');
  // Cloud metadata endpoints that are not link-local: AWS IMDS over IPv6 is ULA, and Alibaba's metadata
  // endpoint sits in CGNAT space. An operator opting in `fd00::/8` or `100.64.0.0/10` would otherwise
  // hand a user-supplied URL a path to instance credentials.
  list.addAddress('fd00:ec2::254', 'ipv6');
  list.addAddress('100.100.100.200', 'ipv4');
  list.addAddress('::', 'ipv6');
  list.addAddress('::1', 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  return list;
}

function parseCidr(cidr: string): { network: string; prefix: number; type: 'ipv4' | 'ipv6' } {
  const [network, prefixText, ...rest] = cidr.trim().split('/');
  const family = isIP(network ?? '');
  const prefix = Number(prefixText);
  const maxPrefix = family === 6 ? 128 : 32;
  if (rest.length > 0 || family === 0 || !/^\d{1,3}$/.test(prefixText ?? '') || prefix > maxPrefix) {
    throw new TypeError(`Invalid CIDR in allowPrivateCidrs: ${cidr}`);
  }
  return { network, prefix, type: family === 6 ? 'ipv6' : 'ipv4' };
}

/**
 * Builds the private-address admission check for `createSsrfSafeLookup`.
 *
 * The family gate refuses any IPv6 spelling that still contains a dot, which is what a dotted
 * IPv4-mapped form re-serializes to (`[::ffff:10.0.0.1]`). An all-hex mapped form (`[::ffff:a00:1]`)
 * has no dot, so it reaches the BlockList, which matches it against the IPv4 CIDRs - it is admitted
 * under the same CIDRs as the bare IPv4 address. That is safe only because `buildNeverAdmitted` is
 * mapped-aware too: `::ffff:7f00:1` is judged as `127.0.0.1` and stays blocked.
 */
export function buildPrivateAddressAdmission(
  options: Pick<PinnedFetchOptions, 'allowPrivateCidrs' | 'testOnlyAllowLoopback'>
): (address: string, family: number) => boolean {
  const { allowPrivateCidrs = [], testOnlyAllowLoopback = false } = options;
  if (testOnlyAllowLoopback && process.env.VITEST !== 'true') {
    throw new Error('testOnlyAllowLoopback is only available under vitest');
  }
  const allowed = new BlockList();
  for (const cidr of allowPrivateCidrs) {
    const { network, prefix, type } = parseCidr(cidr);
    allowed.addSubnet(network, prefix, type);
  }
  const neverAdmitted = buildNeverAdmitted();
  const hasCidrs = allowPrivateCidrs.length > 0;

  return (address, family) => {
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (type === 'ipv6' && address.includes('.')) return false;
    if (testOnlyAllowLoopback && (address === '::1' || (type === 'ipv4' && address.startsWith('127.')))) return true;
    if (!hasCidrs || neverAdmitted.check(address, type)) return false;
    return allowed.check(address, type);
  };
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

type UndiciBody = string | Uint8Array | URLSearchParams;

function toUndiciBody(body: RequestInit['body']): UndiciBody | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || body instanceof URLSearchParams) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  // Streams and multipart are not needed by any caller yet; refusing beats a silent half-duplex mismatch.
  throw new TypeError('pinnedFetch supports string, buffer and URLSearchParams bodies only');
}

function hasSsrfBlockedCause(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === 'object' && 'code' in current && current.code === SSRF_BLOCKED_CODE) return true;
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/** Creates a pinned fetch. Call `close()` when done with it to release its connection pool. */
export function createPinnedFetch(options: PinnedFetchOptions = {}): PinnedFetch {
  const {
    allowHttp = false,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    sameOriginRedirectsOnly = false,
    onViolation,
  } = options;
  const isAllowedPrivate = buildPrivateAddressAdmission(options);
  const hasPrivateOptIn = (options.allowPrivateCidrs?.length ?? 0) > 0 || options.testOnlyAllowLoopback === true;
  const agent = new Agent({
    connect: { lookup: createSsrfSafeLookup({ isAllowedPrivate }), timeout: timeoutMs },
  });

  const violation = (code: PinnedFetchErrorCode, message: string): PinnedFetchError => {
    const error = new PinnedFetchError(code, message);
    onViolation?.(error);
    return error;
  };

  const assertHopAllowed = (url: URL): void => {
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
      throw violation('scheme_blocked', `Scheme ${url.protocol} is not allowed`);
    }
    // WHATWG URL already rewrote decimal, octal and hex IPv4 spellings to dotted form.
    const host = stripBrackets(url.hostname);
    const family = isIP(host);
    if (family !== 0) {
      if (isPrivateIP(host) && !isAllowedPrivate(host, family)) {
        throw violation('ssrf_blocked', `Blocked request to private address ${host}`);
      }
      return;
    }
    if (!hasPrivateOptIn && (isPrivateOrInternalHostname(host) || isNonPublicHostname(host))) {
      throw violation('ssrf_blocked', `Blocked request to internal hostname ${host}`);
    }
  };

  const capBody = (source: ReadableStream<Uint8Array>, timeoutSignal: AbortSignal): ReadableStream<Uint8Array> => {
    const reader = source.getReader();
    let total = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          total += value.byteLength;
          if (total > maxBodyBytes) {
            const error = violation('size_cap', `Response body exceeded ${maxBodyBytes} bytes`);
            await reader.cancel(error).catch(() => undefined);
            controller.error(error);
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(timeoutSignal.aborted ? violation('timeout', `Request exceeded ${timeoutMs} ms`) : error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  };

  const pinnedFetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    let url = new URL(typeof input === 'string' ? input : input.href);
    const startOrigin = url.origin;
    const redirectMode = init.redirect ?? 'follow';
    let method = (init.method ?? 'GET').toUpperCase();
    let body = toUndiciBody(init.body);
    const headers = new Headers(init.headers);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;

    for (let hop = 0; ; hop++) {
      assertHopAllowed(url);

      let upstream: Awaited<ReturnType<typeof undiciFetch>>;
      try {
        upstream = await undiciFetch(url, {
          method,
          headers: Array.from(headers.entries()),
          body,
          redirect: 'manual',
          signal,
          dispatcher: agent,
        });
      } catch (error) {
        if (hasSsrfBlockedCause(error)) {
          throw violation('ssrf_blocked', `Blocked connection to a private address for ${url.hostname}`);
        }
        if (timeoutSignal.aborted && !init.signal?.aborted) {
          throw violation('timeout', `Request exceeded ${timeoutMs} ms`);
        }
        throw error;
      }

      const location = REDIRECT_STATUSES.has(upstream.status) ? upstream.headers.get('location') : null;
      if (location && redirectMode !== 'manual') {
        await upstream.body?.cancel().catch(() => undefined);
        if (redirectMode === 'error') throw new TypeError(`Redirect to ${location} refused (redirect: 'error')`);
        if (hop >= maxRedirects) throw violation('too_many_redirects', `More than ${maxRedirects} redirects`);

        const next = new URL(location, url);
        if (next.origin !== url.origin) {
          if (sameOriginRedirectsOnly && next.origin !== startOrigin) {
            throw violation('redirect_blocked', `Cross-origin redirect to ${next.origin} refused`);
          }
          for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) headers.delete(name);
        }
        if (
          (upstream.status === 303 && method !== 'HEAD') ||
          ((upstream.status === 301 || upstream.status === 302) && method === 'POST')
        ) {
          method = 'GET';
          body = undefined;
          headers.delete('content-type');
          headers.delete('content-length');
        }
        url = next;
        continue;
      }

      const declaredLength = Number(upstream.headers.get('content-length'));
      // A HEAD response, or a status that carries no body, may declare any length; there is nothing to cap.
      if (
        method !== 'HEAD' &&
        !NULL_BODY_STATUSES.has(upstream.status) &&
        Number.isFinite(declaredLength) &&
        declaredLength > maxBodyBytes
      ) {
        await upstream.body?.cancel().catch(() => undefined);
        throw violation('size_cap', `Response body of ${declaredLength} bytes exceeds ${maxBodyBytes}`);
      }

      const responseBody =
        NULL_BODY_STATUSES.has(upstream.status) || !upstream.body ? null : capBody(upstream.body, timeoutSignal);
      const response = new Response(responseBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: Array.from(upstream.headers.entries()),
      });
      // `Response.url` is read-only on the prototype; callers use it to resolve relative Location headers.
      Object.defineProperty(response, 'url', { value: url.href });
      return response;
    }
  };

  return Object.assign(pinnedFetch, { close: () => agent.close() });
}
