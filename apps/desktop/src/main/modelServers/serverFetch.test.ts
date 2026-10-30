import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createServerFetch,
  redactServerResponse,
  ServerRedirectError,
  ServerTransportError,
  type ServerFetchDeps,
} from './serverFetch';

const TOKEN = 'tok-secret-zz';

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const servers: http.Server[] = [];

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body });
      handler(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, port, seen };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

const ok = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"version":"0.12.0"}');
};

function endpoint(origin: string, credentials: Record<string, string> | null = { authorization: `Bearer ${TOKEN}` }) {
  return { origin, label: 'gpu box', credentialHeaders: () => credentials };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the request to fail');
}

describe('createServerFetch', () => {
  it('adds the credential to requests for its own origin and streams the reply', async () => {
    const target = await serve(ok);
    const fetch = createServerFetch(endpoint(target.origin));
    const response = await fetch(`${target.origin}/api/version`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: '0.12.0' });
    expect(target.seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(target.seen[0].body).toBe('{"a":1}');
  });

  it('refuses any other origin before sending anything', async () => {
    const target = await serve(ok);
    const other = await serve(ok);
    const fetch = createServerFetch(endpoint(target.origin));
    const error = await failure(fetch(`${other.origin}/api/version`));
    expect(error).toBeInstanceOf(ServerTransportError);
    expect(other.seen).toHaveLength(0);
  });

  it('never follows a redirect, and says when it pointed at another address', async () => {
    const elsewhere = await serve(ok);
    const target = await serve((req, res) => {
      res.writeHead(302, { location: req.url === '/away' ? `${elsewhere.origin}/steal` : '/api/tags' });
      res.end();
    });
    const fetch = createServerFetch(endpoint(target.origin));

    const away = await failure(fetch(`${target.origin}/away`));
    expect(away).toBeInstanceOf(ServerRedirectError);
    expect((away as ServerRedirectError).crossOrigin).toBe(true);
    expect(away.message).toContain('another address');
    expect(elsewhere.seen).toHaveLength(0);

    const same = await failure(fetch(`${target.origin}/near`));
    expect(same).toBeInstanceOf(ServerRedirectError);
    expect((same as ServerRedirectError).crossOrigin).toBe(false);
  });

  it.each(['same-origin', 'cross-origin'])('does not quote encoded credentials in %s redirects', async kind => {
    const secret = 'token/abc+123=';
    const target = await serve((_req, res) => {
      const path = `/${encodeURIComponent(secret)}`;
      res.writeHead(302, { location: kind === 'same-origin' ? path : `https://${TOKEN}.example.test${path}` });
      res.end();
    });
    const fetch = createServerFetch(endpoint(target.origin, { authorization: `Bearer ${secret}`, 'x-api-key': TOKEN }));
    const error = await failure(fetch(`${target.origin}/`));
    expect(error).toBeInstanceOf(ServerRedirectError);
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(encodeURIComponent(secret));
    expect(error.message).not.toContain(TOKEN);
  });

  it('refuses plain http to a private address when there is a credential, and to a public one always', async () => {
    const privateFetch = createServerFetch(endpoint('http://192.168.1.20:11434'));
    expect(await failure(privateFetch('http://192.168.1.20:11434/api/tags'))).toBeInstanceOf(ServerTransportError);

    const publicFetch = createServerFetch(endpoint('http://8.8.8.8:11434', null));
    expect(await failure(publicFetch('http://8.8.8.8:11434/api/tags'))).toBeInstanceOf(ServerTransportError);
  });

  it('checks the address a name resolves to before the socket opens', async () => {
    const target = await serve(ok);
    const resolveTo =
      (address: string): ServerFetchDeps['lookup'] =>
      (_hostname, options, callback) => {
        if ('all' in options && options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      };
    const origin = `http://models.example.test:${target.port}`;

    const toLan = createServerFetch(endpoint(origin), { lookup: resolveTo('192.168.1.20') });
    const refused = await failure(toLan(`${origin}/api/version`));
    expect(refused).toBeInstanceOf(ServerTransportError);
    expect(refused.message).toMatch(/https/);

    const toLoopback = createServerFetch(endpoint(origin), { lookup: resolveTo('127.0.0.1') });
    expect((await toLoopback(`${origin}/api/version`)).status).toBe(200);
    expect(target.seen).toHaveLength(1);
    expect(target.seen[0].headers.host).toBe(`models.example.test:${target.port}`);
  });

  it('re-runs the address check on a second request instead of reusing a pooled socket', async () => {
    const target = await serve(ok);
    let address = '127.0.0.1';
    let lookups = 0;
    const lookup: ServerFetchDeps['lookup'] = (_hostname, options, callback) => {
      lookups += 1;
      if ('all' in options && options.all) callback(null, [{ address, family: 4 }]);
      else callback(null, address, 4);
    };
    const origin = `http://models.example.test:${target.port}`;
    const fetch = createServerFetch(endpoint(origin), { lookup });

    const first = await fetch(`${origin}/api/version`);
    await first.json();
    address = '192.168.1.20';
    const second = await failure(fetch(`${origin}/api/version`));
    expect(lookups).toBe(2);
    expect(second).toBeInstanceOf(ServerTransportError);
    expect(target.seen).toHaveLength(1);
  });

  it('destroys the response and fails clearly on a status fetch cannot represent', async () => {
    let closed = false;
    const target = await serve((_req, res) => {
      res.on('close', () => (closed = true));
      res.writeHead(999);
      res.write('partial');
    });
    const fetch = createServerFetch(endpoint(target.origin));
    const error = await failure(fetch(`${target.origin}/api/version`));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe('gpu box answered with an invalid HTTP status (999).');
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('rejects a refused connection like fetch does, without the credential in the error', async () => {
    const target = await serve(ok);
    const { port } = target;
    await new Promise(resolve => servers.pop()!.close(resolve));
    const fetch = createServerFetch(endpoint(`http://127.0.0.1:${port}`));
    const error = await failure(fetch(`http://127.0.0.1:${port}/api/version`));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe('fetch failed');
    expect(JSON.stringify({ message: error.message, cause: String(error.cause) })).not.toContain(TOKEN);
  });

  it('redacts the credential from an error body and status text the server echoes back', async () => {
    const target = await serve((req, res) => {
      const value = String(req.headers.authorization ?? req.headers['x-api-key']);
      res.writeHead(req.url === '/401' ? 401 : 500, `Rejected ${value}`, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `bad credential ${value}, token ${value.replace('Bearer ', '')}` }));
    });
    const bearer = createServerFetch(endpoint(target.origin));
    const rejected = await bearer(`${target.origin}/401`);
    expect(rejected.status).toBe(401);
    expect(rejected.statusText).toBe('Rejected [redacted]');
    expect(await rejected.json()).toEqual({ error: 'bad credential [redacted], token [redacted]' });

    const header = createServerFetch(endpoint(target.origin, { 'x-api-key': 'k/ey"1' }));
    const failed = await header(`${target.origin}/500`);
    expect(failed.status).toBe(500);
    const text = await failed.text();
    expect(text).toBe(JSON.stringify({ error: 'bad credential [redacted], token [redacted]' }));
  });

  it('redacts a Go-escaped echo before the body is parsed', async () => {
    const target = await serve((req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: `bad ${req.headers.authorization}` })
          .replace(/&/g, '\\u0026')
          .replace(/</g, '\\u003c')
          .replace(/>/g, '\\u003e')
      );
    });
    const fetch = createServerFetch(endpoint(target.origin, { authorization: 'Bearer tok&en<1>' }));
    expect(await (await fetch(`${target.origin}/`)).json()).toEqual({ error: 'bad [redacted]' });
  });

  it.each([300, 305, 306])('redacts HTTP %i error bodies consumed by clients', async status => {
    const target = await serve((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `bad ${TOKEN}` }));
    });
    const fetch = createServerFetch(endpoint(target.origin));
    const response = await fetch(`${target.origin}/`);
    expect(response.ok).toBe(false);
    expect(await response.json()).toEqual({ error: 'bad [redacted]' });
  });

  it('drops a credential cut at the body limit and marks the body truncated', async () => {
    const secret = 'sentinel-boundary-abcdef0123';
    const target = await serve((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`${'x'.repeat(1024 * 1024 - 10)}${secret}tail`);
    });
    const fetch = createServerFetch(endpoint(target.origin, { 'x-api-key': secret }));
    const text = await (await fetch(`${target.origin}/`)).text();
    expect(text.endsWith('x[truncated]')).toBe(true);
    expect(text).not.toContain(secret.slice(0, 10));
  });

  it('keeps an ordinary error body intact when the credential is a short word', async () => {
    const target = await serve((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"model failed to load"}');
    });
    const fetch = createServerFetch(endpoint(target.origin, { 'x-org': 'e' }));
    expect(await (await fetch(`${target.origin}/`)).json()).toEqual({ error: 'model failed to load' });
  });

  it.each(['compressed', 'mislabeled'])('omits %s encoded error bodies and scrubs their status text', async kind => {
    const text = JSON.stringify({ error: TOKEN });
    const target = await serve((_req, res) => {
      res.writeHead(500, `Rejected ${TOKEN}`, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(kind === 'compressed' ? gzipSync(text) : text);
    });
    const fetch = createServerFetch(endpoint(target.origin));
    const response = await fetch(`${target.origin}/`);
    expect(response.status).toBe(500);
    expect(response.statusText).toBe('Rejected [redacted]');
    expect(response.headers.has('content-encoding')).toBe(false);
    expect(await response.text()).toBe('');
  });

  it('keeps separate request redactors when credentials rotate or are removed', async () => {
    const target = await serve(ok);
    let credentials: Record<string, string> | null = { authorization: `Bearer ${TOKEN}` };
    const fetch = createServerFetch({ origin: target.origin, label: 'gpu box', credentialHeaders: () => credentials });
    const first = await fetch(`${target.origin}/`);
    await first.text();
    credentials = { authorization: 'Bearer replacement-secret' };
    const second = await fetch(`${target.origin}/`);
    await second.text();
    credentials = null;
    expect(redactServerResponse(`bad ${TOKEN}`, first)).toBe('bad [redacted]');
    expect(redactServerResponse('bad replacement-secret', second)).toBe('bad [redacted]');
    expect(redactServerResponse('ordinary reply', first)).toBe('ordinary reply');
  });

  it('reads the credential per request, so a change applies at once', async () => {
    const target = await serve(ok);
    let token = 'first';
    const fetch = createServerFetch({
      origin: target.origin,
      label: 'gpu box',
      credentialHeaders: () => ({ authorization: `Bearer ${token}` }),
    });
    await fetch(`${target.origin}/api/version`);
    token = 'second';
    await fetch(`${target.origin}/api/version`);
    expect(target.seen.map(request => request.headers.authorization)).toEqual(['Bearer first', 'Bearer second']);
  });
});
