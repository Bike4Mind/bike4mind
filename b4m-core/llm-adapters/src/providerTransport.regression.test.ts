import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import OpenAI from 'openai';
import { ChatModels } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import { providerFetchOptions } from './providerDispatcher';

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = async () => ({});
  },
  PutMetricDataCommand: class {},
  StandardUnit: { Count: 'Count' },
}));

const logger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() });

const anthropicError = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

async function settle<T>(p: Promise<T>): Promise<{ ok: boolean; value?: T; error?: unknown }> {
  let done = false;
  const out = p.then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error })
  );
  void out.then(() => (done = true));
  while (!done) await vi.runAllTimersAsync();
  return out;
}

function runAnthropic(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  const backend = new AnthropicBackend('sk-ant-test', logger() as never);
  return settle(
    backend.complete(ChatModels.CLAUDE_4_8_OPUS, [{ role: 'user', content: 'hi' }], { stream: true }, async () => {})
  );
}

describe('provider transport: non-retryable errors surface after one HTTP attempt', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    [400, 'invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'],
    [401, 'authentication_error', 'invalid x-api-key'],
    [403, 'permission_error', 'Your API key does not have permission to use the specified resource.'],
  ])('Anthropic %i %s: one fetch, original status and message preserved', async (status, type, message) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => anthropicError(status, type, message));
    const outcome = await runAnthropic(fetchMock);
    expect(outcome.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const err = outcome.error as { status?: number; message: string };
    expect(err.status).toBe(status);
    expect(err.message).toContain(message);
  });
});

describe('provider transport: real sockets through the shared undici Agent', () => {
  let server: Server | undefined;
  let previousGlobal: Dispatcher | undefined;

  afterEach(async () => {
    if (previousGlobal) setGlobalDispatcher(previousGlobal);
    previousGlobal = undefined;
    await new Promise<void>(r => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function startServer(): Promise<{ baseURL: string; connections: () => number }> {
    let count = 0;
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    });
    server.on('connection', () => count++);
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    return { baseURL: `http://127.0.0.1:${port}/v1`, connections: () => count };
  }

  it("the npm undici Agent works with Node's built-in fetch via the SDK and reuses one socket", async () => {
    const { baseURL, connections } = await startServer();
    const a = new OpenAI({ apiKey: 'k', baseURL, fetchOptions: providerFetchOptions() });
    const b = new OpenAI({ apiKey: 'k', baseURL, fetchOptions: providerFetchOptions() });
    for (let i = 0; i < 4; i++) {
      await a.models.list();
      await b.models.list();
    }
    expect(connections()).toBeLessThanOrEqual(2);
  });

  it('requests bypass a process-wide global dispatcher (e.g. EnvHttpProxyAgent from NODE_USE_ENV_PROXY)', async () => {
    const { baseURL } = await startServer();
    previousGlobal = getGlobalDispatcher();
    const seen: string[] = [];
    class Spy extends Agent {
      dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
        seen.push(String(opts.path));
        return super.dispatch(opts, handler);
      }
    }
    setGlobalDispatcher(new Spy());
    await new OpenAI({ apiKey: 'k', baseURL }).models.list();
    expect(seen).toHaveLength(1);
    await new OpenAI({ apiKey: 'k', baseURL, fetchOptions: providerFetchOptions() }).models.list();
    expect(seen).toHaveLength(1);
  });

  it('an idle keep-alive socket in the shared pool does not hold the Node process open', async () => {
    const { baseURL } = await startServer();
    const modulePath = fileURLToPath(new URL('./providerDispatcher.ts', import.meta.url));
    const script = `
      const { providerDispatcher } = await import(${JSON.stringify(modulePath)});
      const res = await fetch(${JSON.stringify(baseURL + '/models')}, { dispatcher: providerDispatcher() });
      await res.text();
      globalThis.__t = Date.now();
    `;
    const started = Date.now();
    const result = await new Promise<{ code: number | null; stderr: string }>(resolve => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
      let stderr = '';
      child.stderr.on('data', d => (stderr += String(d)));
      const kill = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.on('exit', code => {
        clearTimeout(kill);
        resolve({ code, stderr });
      });
    });
    expect(result.code, result.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
