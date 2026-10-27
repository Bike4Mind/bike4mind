import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MODEL_TOOL_NAMES } from './modelTools';
import { createHttpHandler, isAuthorized, resolveHttpToken } from './serve';

const TOKEN = 'correct-horse-battery-staple';

describe('isAuthorized', () => {
  it('rejects a missing header', () => {
    expect(isAuthorized(undefined, TOKEN)).toBe(false);
  });

  it('rejects a non-bearer scheme', () => {
    expect(isAuthorized(`Basic ${TOKEN}`, TOKEN)).toBe(false);
  });

  it('rejects a wrong token of the same length', () => {
    expect(isAuthorized(`Bearer ${'x'.repeat(TOKEN.length)}`, TOKEN)).toBe(false);
  });

  it('rejects a token of a different length without throwing', () => {
    expect(isAuthorized(`Bearer ${TOKEN}extra`, TOKEN)).toBe(false);
    expect(isAuthorized('Bearer short', TOKEN)).toBe(false);
  });

  it('accepts the correct token', () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });
});

describe('resolveHttpToken', () => {
  it('prefers the flag over the env var', () => {
    expect(resolveHttpToken('from-flag', 'from-env')).toEqual({ token: 'from-flag', source: 'flag' });
  });

  it('falls back to the env var', () => {
    expect(resolveHttpToken(undefined, 'from-env')).toEqual({ token: 'from-env', source: 'env' });
  });

  it('generates a distinct url-safe token when neither is set', () => {
    const a = resolveHttpToken(undefined, undefined);
    const b = resolveHttpToken(undefined, undefined);
    expect(a.source).toBe('generated');
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
  });
});

describe('HTTP handler', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function start(): Promise<string> {
    server = createServer();
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    server.on(
      'request',
      createHttpHandler({ baseURL: 'http://localhost:3000', apiKey: 'b4m_live_key', version: '0.0.0' }, port, TOKEN)
    );
    return `http://127.0.0.1:${port}/mcp`;
  }

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
  };

  function post(url: string, authorization?: string, message: object = initialize): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(message),
    });
  }

  it('never lists the local model tools', async () => {
    const res = await post(await start(), `Bearer ${TOKEN}`, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
    const names = body.result?.tools?.map(tool => tool.name) ?? [];
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter(name => name.startsWith('models_'))).toEqual([]);
    for (const name of MODEL_TOOL_NAMES) expect(names).not.toContain(name);
  });

  it('responds 401 with a Bearer challenge when no header is sent', async () => {
    const res = await post(await start());
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('responds 401 for a wrong token', async () => {
    expect((await post(await start(), 'Bearer nope')).status).toBe(401);
  });

  it('responds 401 for a token of a different length', async () => {
    expect((await post(await start(), `Bearer ${TOKEN}!`)).status).toBe(401);
  });

  it('passes the correct token through to the MCP transport', async () => {
    const res = await post(await start(), `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { serverInfo?: unknown } };
    expect(body.result?.serverInfo).toBeDefined();
  });
});
