import dns from 'dns';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo, Socket } from 'net';
import { gzipSync } from 'zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PinnedFetchError,
  buildPrivateAddressAdmission,
  createPinnedFetch,
  type PinnedFetch,
  type PinnedFetchErrorCode,
  type PinnedFetchOptions,
} from './pinnedFetch';

type LookupCallback = (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void;

const TEN_MB = 10 * 1024 * 1024;
const realLookup = dns.lookup;
let answers: Record<string, string[]> = {};
const seen: Array<{ method: string; path: string; host: string; authorization?: string }> = [];
const sockets = new Set<Socket>();
let server: Server;
let port = 0;
const fetches: PinnedFetch[] = [];

function fakeLookup(hostname: string, options: unknown, callback: LookupCallback): void {
  if (!hostname.endsWith('.test')) {
    (realLookup as unknown as (h: string, o: unknown, c: LookupCallback) => void)(hostname, options, callback);
    return;
  }
  const queue = answers[hostname] ?? ['127.0.0.1'];
  const address = queue.length > 1 ? (queue.shift() as string) : queue[0];
  callback(null, [{ address, family: address.includes(':') ? 6 : 4 }]);
}

function route(req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  seen.push({ method: req.method ?? '', path, host: req.headers.host ?? '', authorization: req.headers.authorization });
  switch (path) {
    case '/ok':
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`ok ${req.method}`);
      return;
    case '/redirect-metadata':
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      return;
    case '/redirect-metadata-name':
      res.writeHead(302, { location: `http://metadata.rebind.test:${port}/ok` }).end();
      return;
    case '/redirect-cross':
      res.writeHead(307, { location: `http://other.fixture.test:${port}/ok` }).end();
      return;
    case '/redirect-loop':
      res.writeHead(307, { location: '/redirect-loop' }).end();
      return;
    case '/see-other':
      res.writeHead(303, { location: '/ok' }).end();
      return;
    case '/big': {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 1);
      let sent = 0;
      const pump = (): void => {
        while (sent < TEN_MB) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
      return;
    }
    case '/declared-big':
      res.writeHead(200, { 'content-length': String(TEN_MB) });
      res.write('x');
      return;
    case '/head-or-304':
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': String(TEN_MB) }).end();
      } else {
        res.writeHead(304, { 'content-length': String(TEN_MB) }).end();
      }
      return;
    case '/gzip-bomb': {
      const body = gzipSync(Buffer.alloc(TEN_MB, 0));
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(body.length) }).end(body);
      return;
    }
    case '/slow':
      return;
    case '/drip': {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => res.write(': ping\n\n'), 20);
      res.on('close', () => clearInterval(timer));
      return;
    }
    default:
      res.writeHead(404).end();
  }
}

function pinned(options: PinnedFetchOptions = {}): PinnedFetch {
  const instance = createPinnedFetch({ allowHttp: true, testOnlyAllowLoopback: true, ...options });
  fetches.push(instance);
  return instance;
}

async function expectViolation(promise: Promise<unknown>, code: PinnedFetchErrorCode): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(PinnedFetchError);
  expect((error as PinnedFetchError).code).toBe(code);
}

const at = (path: string, host = 'fixture.test'): string => `http://${host}:${port}${path}`;

beforeAll(async () => {
  server = createServer(route);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  answers = {};
  seen.length = 0;
  vi.spyOn(dns, 'lookup').mockImplementation(fakeLookup as unknown as typeof dns.lookup);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fetches.splice(0).map(f => f.close()));
});

describe('pinnedFetch - connect-time pinning', () => {
  it('fetches through the pin when the address is admitted', async () => {
    const response = await pinned()(at('/ok'));
    expect(await response.text()).toBe('ok GET');
    expect(response.url).toBe(at('/ok'));
  });

  it('blocks loopback in the production posture', async () => {
    const fetchFn = createPinnedFetch({ allowHttp: true });
    fetches.push(fetchFn);
    await expectViolation(fetchFn(at('/ok')), 'ssrf_blocked');
    expect(seen).toHaveLength(0);
  });

  it('blocks a DNS rebind: the pre-flight sees a public address, the socket would get a private one', async () => {
    answers['rebind.test'] = ['93.184.216.34', '127.0.0.1'];
    const preflight = await new Promise<dns.LookupAddress[]>((resolve, reject) =>
      dns.lookup('rebind.test', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)))
    );
    expect(preflight[0].address).toBe('93.184.216.34');

    const fetchFn = createPinnedFetch({ allowHttp: true });
    fetches.push(fetchFn);
    await expectViolation(fetchFn(at('/ok', 'rebind.test')), 'ssrf_blocked');
    expect(seen).toHaveLength(0);
  });

  it('refuses plain http unless allowed', async () => {
    const fetchFn = createPinnedFetch({ testOnlyAllowLoopback: true });
    fetches.push(fetchFn);
    await expectViolation(fetchFn(at('/ok')), 'scheme_blocked');
  });

  it('reports each refusal through onViolation', async () => {
    const onViolation = vi.fn();
    await expectViolation(pinned({ onViolation })('http://169.254.169.254/'), 'ssrf_blocked');
    expect(onViolation).toHaveBeenCalledWith(expect.objectContaining({ code: 'ssrf_blocked' }));
  });
});

describe('pinnedFetch - redirects', () => {
  it('blocks a redirect to the metadata IP literal before connecting', async () => {
    await expectViolation(pinned()(at('/redirect-metadata')), 'ssrf_blocked');
  });

  it('blocks a redirect to a hostname that resolves to the metadata address, at connect time', async () => {
    answers['metadata.rebind.test'] = ['169.254.169.254'];
    await expectViolation(pinned()(at('/redirect-metadata-name')), 'ssrf_blocked');
  });

  it('refuses a cross-origin redirect in same-origin mode', async () => {
    await expectViolation(pinned({ sameOriginRedirectsOnly: true })(at('/redirect-cross')), 'redirect_blocked');
    expect(seen.some(r => r.host.startsWith('other.fixture.test'))).toBe(false);
  });

  it('follows a cross-origin redirect otherwise, without the credentials', async () => {
    const response = await pinned()(at('/redirect-cross'), { headers: { authorization: 'Bearer secret' } });
    expect(response.status).toBe(200);
    expect(seen[0].authorization).toBe('Bearer secret');
    expect(seen[1].host.startsWith('other.fixture.test')).toBe(true);
    expect(seen[1].authorization).toBeUndefined();
  });

  it('caps redirects at 3 by default', async () => {
    await expectViolation(pinned()(at('/redirect-loop')), 'too_many_redirects');
    expect(seen).toHaveLength(4);
  });

  it('turns a POST into a GET on 303', async () => {
    const response = await pinned()(at('/see-other'), { method: 'POST', body: '{}' });
    expect(await response.text()).toBe('ok GET');
  });

  it('returns the redirect as-is when the caller asks for manual', async () => {
    const response = await pinned()(at('/redirect-metadata'), { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://169.254.169.254/latest/meta-data/');
  });
});

describe('pinnedFetch - body cap and timeout', () => {
  it('aborts a 10 MB streamed body past the cap', async () => {
    const response = await pinned({ maxBodyBytes: 1024 * 1024 })(at('/big'));
    await expectViolation(response.arrayBuffer(), 'size_cap');
  });

  it('refuses a declared Content-Length over the cap without reading it', async () => {
    await expectViolation(pinned({ maxBodyBytes: 1024 })(at('/declared-big')), 'size_cap');
  });

  it('counts decoded bytes, so a small gzip body that inflates past the cap is refused', async () => {
    const response = await pinned({ maxBodyBytes: 1024 * 1024 })(at('/gzip-bomb'));
    await expectViolation(response.arrayBuffer(), 'size_cap');
  });

  it('times out waiting for headers', async () => {
    await expectViolation(pinned({ timeoutMs: 200 })(at('/slow')), 'timeout');
  });

  it('times out a body that never ends', async () => {
    const response = await pinned({ timeoutMs: 200 })(at('/drip'));
    await expectViolation(response.text(), 'timeout');
  });

  it('still honours the caller signal', async () => {
    const controller = new AbortController();
    const pending = pinned()(at('/slow'), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.not.toBeInstanceOf(PinnedFetchError);
  });

  it('does not cap a declared Content-Length on a HEAD response, which has no body', async () => {
    const response = await pinned({ maxBodyBytes: 1024 })(at('/head-or-304'), { method: 'HEAD' });
    expect(response.status).toBe(200);
  });

  it('does not cap a declared Content-Length on a null-body status', async () => {
    const response = await pinned({ maxBodyBytes: 1024 })(at('/head-or-304'));
    expect(response.status).toBe(304);
  });
});

describe('buildPrivateAddressAdmission', () => {
  it('admits only listed private CIDRs, and never loopback, link-local or mapped forms', () => {
    const admit = buildPrivateAddressAdmission({ allowPrivateCidrs: ['10.20.0.0/16', 'fd00::/8', '127.0.0.0/8'] });
    expect(admit('10.20.3.4', 4)).toBe(true);
    expect(admit('10.21.3.4', 4)).toBe(false);
    expect(admit('fd00::5', 6)).toBe(true);
    expect(admit('127.0.0.1', 4)).toBe(false);
    expect(admit('169.254.169.254', 4)).toBe(false);
    expect(admit('::ffff:10.20.3.4', 6)).toBe(false);
  });

  it('admits nothing by default', () => {
    expect(buildPrivateAddressAdmission({})('10.0.0.1', 4)).toBe(false);
  });

  it('never admits loopback, link-local, unspecified or a mapped form, even under a catch-all CIDR', () => {
    const admit = buildPrivateAddressAdmission({ allowPrivateCidrs: ['0.0.0.0/0', '::/0'] });
    expect(admit('169.254.169.254', 4)).toBe(false);
    expect(admit('0.0.0.1', 4)).toBe(false);
    expect(admit('127.0.0.1', 4)).toBe(false);
    expect(admit('::', 6)).toBe(false);
    expect(admit('::1', 6)).toBe(false);
    expect(admit('fe80::1', 6)).toBe(false);
    expect(admit('::ffff:7f00:1', 6)).toBe(false);
  });

  it('never admits the cloud metadata endpoints that are not link-local', () => {
    const admit = buildPrivateAddressAdmission({ allowPrivateCidrs: ['fd00::/8', '100.64.0.0/10'] });
    // AWS IMDS over IPv6 (ULA) and Alibaba's CGNAT endpoint, reachable only through an opt-in otherwise.
    expect(admit('fd00:ec2::254', 6)).toBe(false);
    expect(admit('100.100.100.200', 4)).toBe(false);
    // Their opted-in neighbours stay reachable.
    expect(admit('fd00::5', 6)).toBe(true);
    expect(admit('100.64.0.1', 4)).toBe(true);
  });

  it('rejects a malformed CIDR', () => {
    expect(() => buildPrivateAddressAdmission({ allowPrivateCidrs: ['10.0.0.0'] })).toThrow(TypeError);
    expect(() => buildPrivateAddressAdmission({ allowPrivateCidrs: ['10.0.0.0/33'] })).toThrow(TypeError);
  });

  it('refuses the test-only loopback switch outside vitest', () => {
    const previous = process.env.VITEST;
    process.env.VITEST = '';
    try {
      expect(() => buildPrivateAddressAdmission({ testOnlyAllowLoopback: true })).toThrow(
        /only available under vitest/
      );
    } finally {
      process.env.VITEST = previous;
    }
  });
});
