import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { APIUserAbortError as AnthropicAbort, type Anthropic } from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AnthropicBackend } from './anthropicBackend';
import { OpenAIBackend } from './openaiBackend';
import { XAIBackend } from './xaiBackend';
import { Agent } from 'undici';
import { providerDispatcher } from './providerDispatcher';

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = async () => ({});
  },
  PutMetricDataCommand: class {},
  StandardUnit: { Count: 'Count' },
}));

const logger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() });
const anthropicApi = (b: AnthropicBackend) => (b as unknown as { _api: Anthropic })._api;
const openaiApi = (b: OpenAIBackend | XAIBackend) => (b as unknown as { _api: OpenAI })._api;

const anthropicMessage = JSON.stringify({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const openaiCompletion = JSON.stringify({
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
});

function hangUntilAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    const fail = () => reject(new DOMException('This operation was aborted', 'AbortError'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

describe('fetchOptions merge: the dispatcher does not clobber the SDK request init', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Anthropic: the init reaching fetch carries dispatcher, signal, headers, body and method', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        seen.push(init ?? {});
        return new Response(anthropicMessage, { status: 200, headers: { 'content-type': 'application/json' } });
      })
    );
    const api = anthropicApi(new AnthropicBackend('sk-ant-test', logger() as never));
    const user = new AbortController();
    await api.messages.create(
      { model: 'claude-test', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] },
      { signal: user.signal }
    );

    expect(seen).toHaveLength(1);
    const init = seen[0] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBe(providerDispatcher());
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-api-key')).toBe('sk-ant-test');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'claude-test', max_tokens: 5 });
  });

  it('Anthropic: a user abort reaches the in-flight fetch and is not retried', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => hangUntilAbort(init));
    vi.stubGlobal('fetch', fetchMock);
    const api = anthropicApi(new AnthropicBackend('sk-ant-test', logger() as never));
    const user = new AbortController();
    const pending = api.messages.create(
      { model: 'claude-test', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] },
      { signal: user.signal }
    );
    setTimeout(() => user.abort(), 20);
    const started = Date.now();
    await expect(pending).rejects.toBeInstanceOf(AnthropicAbort);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  });

  it('OpenAI-family (xAI): dispatcher, signal, headers, body survive and a user abort is not retried', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => hangUntilAbort(init));
    vi.stubGlobal('fetch', fetchMock);
    const api = openaiApi(new XAIBackend('xai-test', logger() as never));
    const user = new AbortController();
    const pending = api.chat.completions.create(
      { model: 'grok-test', messages: [{ role: 'user', content: 'hi' }] },
      { signal: user.signal }
    );
    setTimeout(() => user.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(OpenAI.APIUserAbortError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBe(providerDispatcher());
    expect(init.signal?.aborted).toBe(true);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer xai-test');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'grok-test' });
  });
});

type Mode = 'serve' | 'fin-after-response' | 'rst-after-response' | 'fin-on-reuse' | 'rst-on-reuse' | 'hang-on-reuse';

describe('stale keep-alive sockets in the shared pool (real sockets, 127.0.0.1)', () => {
  let server: Server;
  let origin = '';
  let mode: Mode = 'serve';
  let body = anthropicMessage;
  let connections = 0;
  const sockets = new Set<Socket>();
  const perSocket = new WeakMap<Socket, number>();
  const savedEnv = { a: process.env.ANTHROPIC_BASE_URL, o: process.env.OPENAI_BASE_URL };

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const socket = req.socket;
      const n = (perSocket.get(socket) ?? 0) + 1;
      perSocket.set(socket, n);
      req.resume();
      req.on('end', () => {
        if (n >= 2 && mode === 'fin-on-reuse') return void socket.destroy();
        if (n >= 2 && mode === 'rst-on-reuse') return void socket.resetAndDestroy();
        if (n >= 2 && mode === 'hang-on-reuse') return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body, () => {
          if (mode === 'fin-after-response') setTimeout(() => socket.destroy(), 10);
          if (mode === 'rst-after-response') setTimeout(() => socket.resetAndDestroy(), 10);
        });
      });
    });
    server.keepAliveTimeout = 120_000;
    server.on('connection', s => {
      connections++;
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const s of sockets) s.destroy();
    await new Promise(r => setTimeout(r, 50));
    connections = 0;
    mode = 'serve';
    body = anthropicMessage;
    process.env.ANTHROPIC_BASE_URL = savedEnv.a;
    process.env.OPENAI_BASE_URL = savedEnv.o;
    if (savedEnv.a === undefined) delete process.env.ANTHROPIC_BASE_URL;
    if (savedEnv.o === undefined) delete process.env.OPENAI_BASE_URL;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>(r => server.close(() => r()));
  });

  const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

  function anthropicCall(log = logger(), signal?: AbortSignal) {
    process.env.ANTHROPIC_BASE_URL = origin;
    const api = anthropicApi(new AnthropicBackend('sk-ant-test', log as never));
    return api.messages.create(
      { model: 'claude-test', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] },
      { signal, maxRetries: 0 }
    );
  }

  it.each(['fin-after-response', 'rst-after-response'] as const)(
    'peer closes the idle socket (%s): the next turn reconnects with no error and no retry',
    async m => {
      mode = m;
      const log = logger();
      await anthropicCall(log);
      await pause(100);
      await expect(anthropicCall(log)).resolves.toMatchObject({ id: 'msg_1' });
      expect(connections).toBe(2);
      expect(log.warn).not.toHaveBeenCalled();
    }
  );

  it.each(['fin-on-reuse', 'rst-on-reuse'] as const)(
    'Anthropic: socket dies when the next request is written on it (%s): one transparent transport retry, turn succeeds',
    async m => {
      mode = m;
      const log = logger();
      await anthropicCall(log);
      await pause(100);
      const result = await anthropicCall(log);
      expect(result).toMatchObject({ id: 'msg_1' });
      expect(connections).toBe(2);
      expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/Transport error "fetch failed", retry 1\/2/));
    }
  );

  it.each(['fin-on-reuse', 'rst-on-reuse'] as const)(
    'OpenAI: socket dies on reuse (%s): the SDK connection retry reconnects and the call succeeds',
    async m => {
      mode = m;
      body = openaiCompletion;
      process.env.OPENAI_BASE_URL = origin;
      const api = openaiApi(new OpenAIBackend('sk-test', logger() as never));
      const call = () =>
        api.chat.completions.create({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
      await call();
      await pause(100);
      await expect(call()).resolves.toMatchObject({ id: 'c1' });
      expect(connections).toBe(2);
    }
  );

  it('a reused socket that never answers is still cut by the user Stop', { timeout: 10_000 }, async () => {
    mode = 'hang-on-reuse';
    await anthropicCall();
    await pause(100);
    const user = new AbortController();
    const outcome = anthropicCall(logger(), user.signal).then(
      () => 'resolved',
      (e: unknown) => e
    );
    await pause(300);
    const started = Date.now();
    user.abort();
    expect(await outcome).toBeInstanceOf(AnthropicAbort);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(connections).toBe(1);
  });
});

describe('Agent options match the global dispatcher except keep-alive', () => {
  it('only keepAliveTimeout differs from a default undici Agent', async () => {
    const optionsOf = (a: object) => {
      const sym = Object.getOwnPropertySymbols(a).find(s => s.description === 'options') as symbol;
      return (a as Record<symbol, Record<string, unknown>>)[sym];
    };
    const plain = new Agent();
    const ours = optionsOf(providerDispatcher());
    const base = optionsOf(plain);
    const differing = [...new Set([...Object.keys(ours), ...Object.keys(base)])].filter(
      k => typeof ours[k] !== 'function' && JSON.stringify(ours[k]) !== JSON.stringify(base[k])
    );
    expect(differing).toEqual(['keepAliveTimeout']);
    expect(ours.headersTimeout).toBeUndefined();
    expect(ours.bodyTimeout).toBeUndefined();
    expect(ours.allowH2).toBeUndefined();
    expect(ours.pipelining).toBeUndefined();
    await plain.close();
  });
});
