import dns from 'dns';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_RESOURCE_METADATA_URL,
  startRemoteFixtureServer,
  type RemoteFixtureServer,
} from './__fixtures__/remoteFixtureServer';
import { RemoteMcpAuthRequiredError, RemoteMcpError, type RemoteMcpErrorCode } from './errors';
import { RemoteMcpClient, type RemoteMcpClientConfig } from './RemoteMcpClient';

type LookupCallback = (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void;

const realLookup = dns.lookup;
/** Answers for `*.test` hostnames, consumed in order; the last one repeats. Defaults to loopback. */
let answers: Record<string, string[]> = {};
const lookupCalls: string[] = [];

function fakeLookup(hostname: string, options: unknown, callback: LookupCallback): void {
  if (!hostname.endsWith('.test')) {
    (realLookup as unknown as (h: string, o: unknown, c: LookupCallback) => void)(hostname, options, callback);
    return;
  }
  lookupCalls.push(hostname);
  const queue = answers[hostname] ?? ['127.0.0.1'];
  const address = queue.length > 1 ? (queue.shift() as string) : queue[0];
  callback(null, [{ address, family: address.includes(':') ? 6 : 4 }]);
}

let fixture: RemoteFixtureServer;

function client(path: string, config: Partial<RemoteMcpClientConfig> = {}, host = 'fixture.test'): RemoteMcpClient {
  return new RemoteMcpClient(
    { url: `http://${host}:${fixture.port}${path}`, allowHttp: true, ...config },
    { allowLoopback: true }
  );
}

async function expectCode(promise: Promise<unknown>, code: RemoteMcpErrorCode): Promise<RemoteMcpError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(RemoteMcpError);
  expect((error as RemoteMcpError).code).toBe(code);
  return error as RemoteMcpError;
}

beforeAll(async () => {
  fixture = await startRemoteFixtureServer();
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(() => {
  answers = {};
  lookupCalls.length = 0;
  fixture.requests.length = 0;
  vi.spyOn(dns, 'lookup').mockImplementation(fakeLookup as unknown as typeof dns.lookup);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RemoteMcpClient - round trips', () => {
  it('lists tools over Streamable HTTP, statelessly, and DELETEs the session it was issued', async () => {
    const remote = client('/mcp');
    const result = await remote.listTools();

    expect(result.detectedTransport).toBe('streamable-http');
    expect(remote.detectedTransport).toBe('streamable-http');
    expect(result.serverInfo?.name).toBe('fixture');
    expect(result.tools.map(t => t.name).sort()).toEqual(['echo', 'fail', 'hang']);
    expect(result.tools.find(t => t.name === 'echo')?.annotations?.readOnlyHint).toBe(true);

    const sessionIds = new Set(fixture.requests.map(r => r.sessionId).filter(Boolean));
    expect(sessionIds.size).toBe(1);
    expect(fixture.requests.some(r => r.method === 'DELETE' && r.sessionId)).toBe(true);
  });

  it('calls a tool, each call on its own session', async () => {
    const remote = client('/mcp');
    const first = await remote.callTool('echo', { text: 'hi' });
    const second = await remote.callTool('echo', { text: 'again' });

    expect(first.result.content).toEqual([{ type: 'text', text: 'echo: hi' }]);
    expect(second.result.content).toEqual([{ type: 'text', text: 'echo: again' }]);
    const deletes = fixture.requests.filter(r => r.method === 'DELETE');
    expect(new Set(deletes.map(r => r.sessionId)).size).toBe(2);
  });

  it('returns a tool-level error as a result, not a throw', async () => {
    const { result } = await client('/mcp').callTool('fail');
    expect(result.isError).toBe(true);
  });

  it('falls back to legacy SSE when initialize gets a 405, and reports it', async () => {
    const remote = client('/legacy');
    const listed = await remote.listTools();
    expect(listed.detectedTransport).toBe('sse');
    expect(remote.detectedTransport).toBe('sse');

    const called = await remote.callTool('echo', { text: 'old' });
    expect(called.detectedTransport).toBe('sse');
    expect(called.result.content).toEqual([{ type: 'text', text: 'echo: old' }]);
    // The second operation reuses the detected transport instead of probing again.
    expect(fixture.requests.filter(r => r.path === '/legacy' && r.method === 'POST')).toHaveLength(1);
  });

  it('does not fall back when the transport is pinned to streamable-http', async () => {
    await expectCode(client('/legacy', { transport: 'streamable-http' }).listTools(), 'protocol');
  });

  it('follows a same-origin redirect', async () => {
    const result = await client('/redirect-same').listTools();
    expect(result.tools.length).toBe(3);
  });
});

describe('RemoteMcpClient - tool list limits', () => {
  it('caps the count, truncates descriptions and drops oversized schemas', async () => {
    const result = await client('/many').listTools();

    expect(result.tools).toHaveLength(100);
    expect(result.tools.every(t => t.description.length <= 1024)).toBe(true);
    expect(result.tools.find(t => t.name === 'long_description')?.description).toHaveLength(1024);
    expect(result.dropped).toContainEqual({ name: 'huge_schema', reason: 'schema_too_large' });
    expect(result.dropped.filter(d => d.reason === 'max_tools').length).toBeGreaterThan(0);
  });

  it('drops tools once the total schema budget is spent', async () => {
    const result = await client('/many', { limits: { maxTotalSchemaBytes: 2048 } }).listTools();
    expect(result.dropped.some(d => d.reason === 'total_schema_too_large')).toBe(true);
  });
});

describe('RemoteMcpClient - SSRF', () => {
  it('blocks a DNS rebind at connect time: public at pre-flight, private at connect', async () => {
    answers['rebind.test'] = ['93.184.216.34', '127.0.0.1'];
    // A pre-flight check (as the create route will run) sees the public answer.
    const preflight = await new Promise<dns.LookupAddress[]>((resolve, reject) =>
      dns.lookup('rebind.test', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)))
    );
    expect(preflight[0].address).toBe('93.184.216.34');

    // No loopback allowance here: this is the production posture.
    const remote = new RemoteMcpClient({ url: `http://rebind.test:${fixture.port}/mcp`, allowHttp: true });
    await expectCode(remote.listTools(), 'ssrf_blocked');
    expect(lookupCalls.filter(host => host === 'rebind.test').length).toBeGreaterThanOrEqual(2);
    expect(fixture.requests).toHaveLength(0);
  });

  it('refuses a redirect to the metadata address', async () => {
    await expectCode(client('/redirect-metadata').listTools(), 'protocol');
    expect(fixture.requests.every(r => r.path === '/redirect-metadata')).toBe(true);
  });

  it('refuses a cross-origin redirect', async () => {
    await expectCode(client('/redirect-cross').listTools(), 'protocol');
    expect(fixture.requests.some(r => r.host.startsWith('other.fixture.test'))).toBe(false);
  });

  it('refuses a same-origin redirect loop past the limit', async () => {
    await expectCode(client('/redirect-loop').listTools(), 'protocol');
    expect(fixture.requests.filter(r => r.path === '/redirect-loop').length).toBeLessThanOrEqual(4);
  });

  it('rejects an invalid URL before any network access', async () => {
    const remote = new RemoteMcpClient({ url: 'https://169.254.169.254/latest/meta-data' });
    await expectCode(remote.listTools(), 'invalid_url');
    expect(lookupCalls).toHaveLength(0);
  });
});

describe('RemoteMcpClient - caps and timeouts', () => {
  it('aborts a 10 MB body at the size cap', async () => {
    await expectCode(client('/big').listTools(), 'size_cap');
  });

  it('caps decoded bytes, so a small gzip body that inflates to 10 MB is refused', async () => {
    await expectCode(client('/gzip-bomb').listTools(), 'size_cap');
  });

  it('times out a server that never answers', async () => {
    const started = Date.now();
    await expectCode(client('/slow', { limits: { connectTimeoutMs: 300 } }).listTools(), 'timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('bounds a Streamable HTTP response stream that never ends', async () => {
    const started = Date.now();
    await expectCode(client('/stream-forever', { limits: { connectTimeoutMs: 300 } }).listTools(), 'timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('bounds a legacy SSE stream that never sends its endpoint', async () => {
    const started = Date.now();
    await expectCode(client('/legacy-silent', { limits: { connectTimeoutMs: 300 } }).listTools(), 'timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('deletes an issued session after a tool call times out', async () => {
    await expectCode(client('/mcp', { limits: { callTimeoutMs: 100 } }).callTool('hang'), 'timeout');
    expect(fixture.requests.some(r => r.method === 'DELETE' && r.sessionId)).toBe(true);
  });
});

describe('RemoteMcpClient - auth and upstream errors', () => {
  it('surfaces a 401 as auth_required with the resource metadata URL and scope', async () => {
    const error = await expectCode(client('/unauthorized').listTools(), 'auth_required');
    expect(error).toBeInstanceOf(RemoteMcpAuthRequiredError);
    const auth = error as RemoteMcpAuthRequiredError;
    expect(auth.resourceMetadataUrl).toBe(FIXTURE_RESOURCE_METADATA_URL);
    expect(auth.scope).toBe('tools.read');
  });

  it('maps a 403 to auth_failed', async () => {
    await expectCode(client('/forbidden').listTools(), 'auth_failed');
  });

  it('maps a 5xx to upstream_5xx', async () => {
    await expectCode(client('/broken').listTools(), 'upstream_5xx');
  });
});

describe('RemoteMcpClient - test-only loopback', () => {
  it('cannot be enabled outside vitest', async () => {
    const previous = process.env.VITEST;
    process.env.VITEST = '';
    try {
      await expect(client('/mcp').listTools()).rejects.toThrow(/only available under vitest/);
    } finally {
      process.env.VITEST = previous;
    }
  });
});
