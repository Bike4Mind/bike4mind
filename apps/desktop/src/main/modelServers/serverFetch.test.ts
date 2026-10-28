import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerFetch, ServerRedirectError, ServerTransportError, type ServerFetchDeps } from './serverFetch';

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
    expect(away.message).toContain(elsewhere.origin);
    expect(elsewhere.seen).toHaveLength(0);

    const same = await failure(fetch(`${target.origin}/near`));
    expect(same).toBeInstanceOf(ServerRedirectError);
    expect((same as ServerRedirectError).crossOrigin).toBe(false);
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
