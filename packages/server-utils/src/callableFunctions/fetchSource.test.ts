// @vitest-environment node
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CallableFunctionSourceError,
  createLambdaCallableFunctionSourceFetcher,
  fetchCallableFunctionSource,
  runCallableFunctionSourceFetchForLambda,
  type CallableFunctionSourceFetchRequest,
} from './fetchSource';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function listen(handler: Handler): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const CSV = Buffer.from('x,y\n1,2\n');
let rebound = false;
let data: { server: Server; origin: string };
let other: { server: Server; origin: string };

beforeAll(async () => {
  other = await listen((_req, res) => res.end('other origin'));
  data = await listen((req, res) => {
    if (req.url === '/data.csv') return void res.end(CSV);
    if (req.url === '/moved') return void res.writeHead(302, { location: '/data.csv' }).end();
    if (req.url === '/rebind') {
      rebound = true;
      return void res.writeHead(302, { location: '/data.csv', connection: 'close' }).end();
    }
    if (req.url === '/to-other') return void res.writeHead(302, { location: `${other.origin}/data.csv` }).end();
    if (req.url === '/big') return void res.end(Buffer.alloc(1025, 1));
    if (req.url === '/slow') return void setTimeout(() => res.end(CSV), 1500);
    res.writeHead(404).end();
  });
});

afterAll(async () => {
  await Promise.all([data, other].map(({ server }) => new Promise(resolve => server.close(resolve))));
});

const request = (path: string, overrides: Partial<CallableFunctionSourceFetchRequest> = {}) => ({
  url: `${data.origin}${path}`,
  origins: [data.origin],
  maxBodyBytes: 1024,
  timeoutMs: 1000,
  ...overrides,
});

const loopback = { allowLoopbackHttp: true };

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(CallableFunctionSourceError);
  return (error as CallableFunctionSourceError).code;
}

describe('fetchCallableFunctionSource', () => {
  it('reads a listed origin, following a same-origin redirect, and hashes the body', async () => {
    const result = await fetchCallableFunctionSource(request('/moved'), loopback);
    expect(result.body.equals(CSV)).toBe(true);
    expect(result.sha256).toBe(createHash('sha256').update(CSV).digest('hex'));
    expect(result.bytes).toBe(CSV.length);
    expect(Number.isNaN(Date.parse(result.fetchedAt))).toBe(false);
  });

  it('refuses an origin that is not listed, before any connection', async () => {
    expect(
      await refusal(fetchCallableFunctionSource(request('/data.csv', { origins: [other.origin] }), loopback))
    ).toBe('source_origin_unlisted');
  });

  it('refuses a private address', async () => {
    const url = 'http://10.255.255.1/data.csv';
    expect(
      await refusal(fetchCallableFunctionSource(request('', { url, origins: ['http://10.255.255.1'] }), loopback))
    ).toBe('source_blocked');
  });

  it('refuses a same-origin redirect whose next connection resolves to a private address', async () => {
    const origin = `http://data.rebind.test:${new URL(data.origin).port}`;
    const lookup = vi
      .spyOn(dns, 'lookup')
      .mockImplementation(((
        _hostname: string,
        _options: unknown,
        callback: (error: null, addresses: dns.LookupAddress[]) => void
      ) =>
        callback(null, [
          { address: rebound ? '10.255.255.1' : '127.0.0.1', family: 4 },
        ])) as unknown as typeof dns.lookup);
    try {
      expect(
        await refusal(
          fetchCallableFunctionSource(request('', { url: `${origin}/rebind`, origins: [origin] }), loopback)
        )
      ).toBe('source_blocked');
      expect(rebound).toBe(true);
    } finally {
      lookup.mockRestore();
      rebound = false;
    }
  });

  it('refuses a cross-origin redirect, even to another reachable origin', async () => {
    expect(await refusal(fetchCallableFunctionSource(request('/to-other'), loopback))).toBe('source_redirect_blocked');
  });

  it('refuses a body over the cap', async () => {
    expect(await refusal(fetchCallableFunctionSource(request('/big'), loopback))).toBe('source_too_large');
  });

  it('refuses a source that does not answer in time', async () => {
    expect(await refusal(fetchCallableFunctionSource(request('/slow', { timeoutMs: 200 }), loopback))).toBe(
      'source_timeout'
    );
  });

  it('refuses plain http and loopback without the test switch', async () => {
    expect(await refusal(fetchCallableFunctionSource(request('/data.csv')))).toBe('source_blocked');
  });
});

describe('the Lambda fetcher', () => {
  const viaLambda = () =>
    createLambdaCallableFunctionSourceFetcher('source-fetch', async command => ({
      Payload: Buffer.from(
        JSON.stringify(
          await runCallableFunctionSourceFetchForLambda(
            JSON.parse(Buffer.from(command.input.Payload as Uint8Array).toString('utf8')),
            req => fetchCallableFunctionSource(req, loopback)
          )
        )
      ),
    }));

  it('returns the same bytes and hash as an in-process fetch', async () => {
    const direct = await fetchCallableFunctionSource(request('/data.csv'), loopback);
    const remote = await viaLambda()(request('/data.csv'));
    expect(remote.body.equals(direct.body)).toBe(true);
    expect(remote.sha256).toBe(direct.sha256);
  });

  it('carries a refusal across as the same code', async () => {
    expect(await refusal(viaLambda()(request('/to-other')))).toBe('source_redirect_blocked');
  });

  it('refuses a reply whose bytes do not match its hash', async () => {
    const lying = createLambdaCallableFunctionSourceFetcher('source-fetch', async () => ({
      Payload: Buffer.from(
        JSON.stringify({
          ok: true,
          body: CSV.toString('base64'),
          sha256: '0'.repeat(64),
          bytes: CSV.length,
          fetchedAt: '',
        })
      ),
    }));
    await expect(lying(request('/data.csv'))).rejects.toThrow('Callable function source fetch invocation failed');
  });
});
