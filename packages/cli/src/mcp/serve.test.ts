import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConfigStore } from '../storage/ConfigStore';
import { ApiEndpointUnconfiguredError } from '../utils/apiUrl';
import { B4mApiClient } from './b4mApiClient';
import { MODEL_TOOL_NAMES } from './modelTools';
import {
  buildServeStdioServer,
  createHttpHandler,
  handleMcpServeCommand,
  isAuthorized,
  resolveHttpToken,
} from './serve';

const TOKEN = 'correct-horse-battery-staple';

async function toolNames(server: McpServer): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map(tool => tool.name);
}

describe('buildServeStdioServer', () => {
  const unconfigured = () =>
    ({
      getApiConfig: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue({}),
    }) as unknown as ConfigStore;
  let stderr: string[];

  beforeEach(() => {
    vi.stubEnv('B4M_API_URL', undefined);
    vi.stubEnv('B4M_DEFAULT_API_URL', '');
    vi.stubEnv('B4M_SOURCE_MODE', '');
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(B4mApiClient.prototype, 'getSolverCatalog').mockRejectedValue(new Error('offline'));
    vi.spyOn(B4mApiClient.prototype, 'getOwnKeyScopes').mockRejectedValue(new Error('offline'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('serves only the model tools under --local without resolving an endpoint', async () => {
    const configStore = unconfigured();
    const names = await toolNames(await buildServeStdioServer({ local: true, version: '0.0.0' }, configStore));
    expect(names).toEqual([...MODEL_TOOL_NAMES]);
    expect(configStore.getApiConfig).not.toHaveBeenCalled();
    expect(stderr).toEqual([
      'Serving local model tools only (models_list, models_search, models_pull, models_remove); drop --local to serve the Bike4Mind tools.\n',
    ]);
  });

  it('ignores a configured endpoint under --local', async () => {
    vi.stubEnv('B4M_API_URL', 'http://localhost:3000');
    const names = await toolNames(await buildServeStdioServer({ local: true, version: '0.0.0' }, unconfigured()));
    expect(names).toEqual([...MODEL_TOOL_NAMES]);
  });

  it('still fails without --local when no endpoint is configured', async () => {
    await expect(buildServeStdioServer({ version: '0.0.0' }, unconfigured())).rejects.toThrow(
      ApiEndpointUnconfiguredError
    );
    await expect(buildServeStdioServer({ version: '0.0.0' }, unconfigured())).rejects.toThrow(
      'No API endpoint configured'
    );
    expect(stderr).toEqual([]);
  });

  it('serves the full tool set without --local when an endpoint is configured', async () => {
    const names = await toolNames(
      await buildServeStdioServer({ apiUrl: 'http://localhost:3000', version: '0.0.0' }, unconfigured())
    );
    const backendTools = names.slice(0, -MODEL_TOOL_NAMES.length);
    expect(names.slice(-MODEL_TOOL_NAMES.length)).toEqual([...MODEL_TOOL_NAMES]);
    expect(backendTools.length).toBeGreaterThan(0);
    expect(new Set(backendTools).size).toBe(backendTools.length);
    expect(backendTools).toEqual(expect.arrayContaining(['list_notebooks', 'send_message']));
    expect(backendTools.filter(name => name.startsWith('models_'))).toEqual([]);
    expect(stderr).toEqual([]);
  });
});

describe('handleMcpServeCommand', () => {
  it('rejects --local with --http before touching stdout', async () => {
    const write = process.stdout.write;
    await expect(handleMcpServeCommand({ local: true, http: true, version: '0.0.0' })).rejects.toThrow(
      '--local serves over stdio only; drop --http.'
    );
    expect(process.stdout.write).toBe(write);
  });
});

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
