import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMessage, ModelInfo } from '@bike4mind/common';
import { OllamaBackend, OpenAICompatibleBackend, type ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { readDesktopModelServers } from '@bike4mind/local-models/servers';
import {
  json,
  startFakeServer,
  startFakeVllm,
  type FakeServer,
  type FakeVllm,
  type Handler,
} from '@bike4mind/local-models/testing';
import { loadModelServers } from '../models/modelServers.js';
import { MultiLlmBackend } from '../llm/MultiLlmBackend.js';
import { createMockConfig } from '../test-utils/mocks.js';
import { attachLocalModels, type AttachLocalModelsOptions, type BuildLlmBackendDeps } from './buildLlmBackend.js';

const TOKEN = 'tok-5e4d3c2b1a0f9e8d7c6b';
const silent = { debug() {}, info() {}, warn() {}, error() {} } as never;
const hosted = { id: 'hosted-1', name: 'Hosted' } as unknown as ModelInfo;
/** What the fake vLLM serves, as ids on a server saved as s1. */
const VLLM_IDS = ['local:srv-s1:qwen-small', 'local:srv-s1:sql-lora'];
const user = (content: string) => [{ role: 'user', content }] as unknown as IMessage[];

let dir: string;
let notices: string[];
const open: { close(): Promise<void> }[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'b4m-chat-servers-'));
  notices = [];
  vi.stubEnv('B4M_OLLAMA_HOST', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(open.splice(0).map(server => server.close()));
  await rm(dir, { recursive: true, force: true });
});

function record(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'aaa',
    name: 'shared',
    kind: 'ollama',
    transport: { type: 'http', baseUrl: 'http://127.0.0.1:1' },
    access: 'chat',
    auth: { type: 'none' },
    models: [],
    addedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

const vllmRecord = (id: string, name: string, fake: FakeVllm) =>
  record({ id, name, kind: 'openai-compatible', transport: { type: 'http', baseUrl: fake.baseUrl } });

const lockedRecord = (fake: FakeServer) =>
  record({ id: 'o1', name: 'locked', auth: { type: 'bearer' }, transport: { type: 'http', baseUrl: fake.baseUrl } });

const downRecord = (id: string, name: string, port: number) =>
  record({ id, name, transport: { type: 'http', baseUrl: `http://127.0.0.1:${port}` } });

async function vllm(options: { toolFlags?: boolean; maxModelLen?: number } = {}): Promise<FakeVllm> {
  const fake = await startFakeVllm(options);
  open.push(fake);
  return fake;
}

/** Accepts connections and never answers; with `headers`, sends response headers and then nothing more. */
async function silentServer(headers = false): Promise<{ baseUrl: string; open(): number }> {
  const sockets = new Set<Socket>();
  const server = headers
    ? http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"vers');
      })
    : net.createServer(() => undefined);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  open.push({
    close: () =>
      new Promise<void>(resolve => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  });
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, open: () => sockets.size };
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = await startFakeServer({});
  await server.close();
  return server.port;
}

async function writeServers(servers: Record<string, unknown>[]): Promise<void> {
  await writeFile(path.join(dir, 'model-servers.json'), JSON.stringify({ version: 1, servers }));
}

/** An Ollama serving one model without tool support; with a token it answers only to that bearer. */
async function ollama(token?: string, routes: Record<string, Handler> = {}): Promise<FakeServer> {
  const guard =
    (inner: Handler): Handler =>
    (request, response) => {
      if (!token || request.headers.authorization === `Bearer ${token}`) return inner(request, response);
      return json({ error: `unauthorized: ${String(request.headers.authorization)}` }, 401)(request, response);
    };
  const server = await startFakeServer({
    'GET /api/version': guard(json({ version: '0.12.0' })),
    'GET /api/tags': guard(
      json({ models: [{ name: 'tiny:1b', model: 'tiny:1b', size: 1, digest: 'a'.repeat(64), details: {} }] })
    ),
    'POST /api/show': guard(json({ capabilities: ['completion'], model_info: { 'tiny.context_length': 8192 } })),
    'POST /api/chat': guard((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(
        `${JSON.stringify({ model: 'tiny:1b', message: { role: 'assistant', content: 'Hi.' }, done: false })}\n`
      );
      response.end(
        `${JSON.stringify({ model: 'tiny:1b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 2 })}\n`
      );
    }),
    ...Object.fromEntries(Object.entries(routes).map(([route, handler]) => [route, guard(handler)])),
  });
  open.push(server);
  return server;
}

const deps: Pick<
  BuildLlmBackendDeps,
  'createOllamaBackend' | 'createOpenAICompatibleBackend' | 'createMultiBackend' | 'loadModelServers'
> = {
  createOllamaBackend: (host, options) =>
    new OllamaBackend(host, silent, { fetch: options?.fetch as typeof globalThis.fetch | undefined }),
  createOpenAICompatibleBackend: options => new OpenAICompatibleBackend({ ...options, logger: silent }),
  createMultiBackend: (server, serverModels, routes, defaultModel) =>
    new MultiLlmBackend(server, serverModels, routes, defaultModel),
  loadModelServers: () => loadModelServers(() => readDesktopModelServers({ dirs: [dir] })),
};

const serverBackend = () => ({
  currentModel: 'hosted-1',
  getModelInfo: async () => [hosted],
  complete: vi.fn(async () => undefined),
  pushToolMessages: vi.fn(),
});

function attach(
  config: Parameters<typeof createMockConfig>[0],
  opts: AttachLocalModelsOptions = { servers: 'all' },
  hostedBackend = serverBackend()
) {
  return attachLocalModels(
    hostedBackend as never,
    createMockConfig({ defaultModel: 'hosted-1', ...config }),
    { listingTimeoutMs: 2_000, onNotice: text => notices.push(text), ...opts },
    deps
  );
}

const weatherTool = (toolFn: ICompletionOptionTools['toolFn'], padding = 0): ICompletionOptionTools => ({
  toolFn,
  toolSchema: {
    name: 'get_weather',
    description: 'Current weather for a city.' + ' x'.repeat(padding),
    parameters: { type: 'object', properties: { city: { type: 'string', description: 'City' } }, required: ['city'] },
  },
});

async function chat(
  llm: { complete: MultiLlmBackend['complete'] },
  model: string,
  tools: ICompletionOptionTools[] = []
): Promise<string> {
  let text = '';
  await llm.complete(model, user('What is the weather in Paris?'), { stream: true, tools }, async parts => {
    text += parts.filter(Boolean).join('');
  });
  return text;
}

describe('attachLocalModels with saved model servers', () => {
  it('lists the same model on two servers as two entries named by server', async () => {
    const [a, b] = [await vllm(), await vllm()];
    await writeServers([vllmRecord('s1', 'box-a', a), vllmRecord('s2', 'box-b', b)]);
    const added: ModelInfo[][] = [];
    const attached = await attach({}, { servers: 'all', onModelsAdded: models => added.push(models) });
    expect(attached.models).toEqual([hosted]);
    expect(attached.servers).toEqual([]);
    await attached.later;
    const models = await attached.llm.getModelInfo();
    const entries = models.filter(model => model.name.startsWith('qwen-small on'));
    expect(entries.map(model => [model.id, model.name]).sort()).toEqual([
      ['local:srv-s1:qwen-small', 'qwen-small on box-a'],
      ['local:srv-s2:qwen-small', 'qwen-small on box-b'],
    ]);
    expect(entries[0].description).toMatch(/^Served by box-., a model server saved in Desktop\./);
    expect(models[0]).toBe(hosted);
    expect(added).toHaveLength(2);
    expect(added[1]).toEqual(models);
  });

  it('routes a server model to its server with the bare name, and a hosted model to the B4M server', async () => {
    const [a, b] = [await vllm(), await vllm()];
    await writeServers([vllmRecord('s1', 'box-a', a), vllmRecord('s2', 'box-b', b)]);
    const hostedBackend = serverBackend();
    const { llm, servers, later } = await attach(
      { defaultModel: 'local:srv-s2:qwen-small' },
      { servers: 'all' },
      hostedBackend
    );
    expect(servers).toEqual([{ name: 'box-b', modelCount: 2 }]);
    await later;
    expect(await chat(llm, 'local:srv-s2:qwen-small')).toBe('Hello.');
    expect(b.requests.map(request => request.model)).toEqual(['qwen-small']);
    expect(a.requests).toEqual([]);
    await chat(llm, 'hosted-1');
    expect(hostedBackend.complete).toHaveBeenCalledOnce();
  });

  it('round-trips a tool call on a vLLM started with tool calling', async () => {
    const fake = await vllm();
    await writeServers([vllmRecord('s1', 'vllm', fake)]);
    const { llm } = await attach({ defaultModel: 'local:srv-s1:qwen-small' }, { servers: 'default' });
    const toolFn = vi.fn(async () => '21C and sunny');
    expect(await chat(llm, 'local:srv-s1:qwen-small', [weatherTool(toolFn)])).toContain('It is 21C in Paris.');
    expect(toolFn).toHaveBeenCalledWith({ city: 'Paris' });
    expect(fake.requests).toHaveLength(2);
    const followUp = fake.requests[1].messages as { role: string }[];
    expect(followUp[followUp.length - 1].role).toBe('tool');
    expect(notices).toEqual([]);
  });

  it('answers without tools and says why once when vLLM was started without tool calling', async () => {
    const fake = await vllm({ toolFlags: false });
    await writeServers([vllmRecord('s1', 'vllm', fake)]);
    const { llm } = await attach({ defaultModel: 'local:srv-s1:qwen-small' }, { servers: 'default' });
    const tools = [weatherTool(async () => 'unused')];
    expect(await chat(llm, 'local:srv-s1:qwen-small', tools)).toBe('Hello.');
    expect(await chat(llm, 'local:srv-s1:qwen-small', tools)).toBe('Hello.');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('vllm was started without tool calling');
    expect(notices[0]).toContain('--enable-auto-tool-choice');
    expect(notices[0]).toContain('then start a new b4m session.');
  });

  it('answers without tools when the fixed context cannot hold them, naming the --max-model-len to use', async () => {
    const fake = await vllm({ maxModelLen: 4096 });
    await writeServers([vllmRecord('s1', 'vllm', fake)]);
    const { llm } = await attach({ defaultModel: 'local:srv-s1:qwen-small' }, { servers: 'default' });
    expect(await chat(llm, 'local:srv-s1:qwen-small', [weatherTool(async () => 'unused', 8000)])).toBe('Hello.');
    expect(fake.requests.every(request => request.tools === undefined)).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("too small for the CLI's instructions and tools");
    expect(notices[0]).toContain('--max-model-len 16384');
  });

  it('chats with an Ollama server through its saved credential and drops tools for a model without them', async () => {
    const fake = await ollama(TOKEN);
    await writeServers([lockedRecord(fake)]);
    const { llm, models } = await attach({
      defaultModel: 'local:srv-o1:tiny:1b',
      modelServerCredentials: { o1: { secret: TOKEN } },
    });
    expect(models.map(model => model.id)).toContain('local:srv-o1:tiny:1b');
    const tools = [weatherTool(async () => 'unused')];
    expect(await chat(llm, 'local:srv-o1:tiny:1b', tools)).toBe('Hi.');
    expect(await chat(llm, 'local:srv-o1:tiny:1b', tools)).toBe('Hi.');
    const sent = fake.requests.filter(request => request.path === '/api/chat').map(request => JSON.parse(request.body));
    expect(sent.map(body => [body.model, body.tools])).toEqual([
      ['tiny:1b', undefined],
      ['tiny:1b', undefined],
    ]);
    expect(notices).toEqual([
      'tiny:1b on locked has no tool support, so the CLI chats with it without tools. Pick a model with tool support to use tools.',
    ]);
  });

  it('keeps the credential out of an error frame inside a 200 stream from an Ollama server', async () => {
    const fake = await ollama(TOKEN, {
      'POST /api/chat': (request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(`${JSON.stringify({ error: `upstream refused ${String(request.headers.authorization)}` })}\n`);
      },
    });
    await writeServers([lockedRecord(fake)]);
    const logged: string[] = [];
    const logging = {
      ...deps,
      createOllamaBackend: (host: string, options?: { fetch?: unknown; redact?: (text: string) => string }) => {
        const line = (...args: unknown[]) => logged.push((options?.redact ?? String)(args.map(String).join(' ')));
        return new OllamaBackend(
          host,
          { debug: line, info: line, warn: line, error: line },
          { fetch: options?.fetch as typeof globalThis.fetch }
        );
      },
    };
    const { llm } = await attachLocalModels(
      serverBackend() as never,
      createMockConfig({ defaultModel: 'local:srv-o1:tiny:1b', modelServerCredentials: { o1: { secret: TOKEN } } }),
      { servers: 'default' },
      logging
    );
    const error = await chat(llm, 'local:srv-o1:tiny:1b').then(
      () => null,
      (err: Error) => err
    );
    expect(error?.message).toContain('upstream refused [redacted]');
    expect(`${error?.message} ${error?.stack}`).not.toContain(TOKEN);
    expect(logged.some(line => line.includes('[redacted]'))).toBe(true);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });

  it('says tool support could not be checked when the Ollama server does not answer /api/show', async () => {
    const fake = await ollama(undefined, { 'POST /api/show': json({ error: 'busy' }, 500) });
    await writeServers([record({ id: 'o1', name: 'shared', transport: { type: 'http', baseUrl: fake.baseUrl } })]);
    const { llm } = await attach({ defaultModel: 'local:srv-o1:tiny:1b' }, { servers: 'default' });
    expect(await chat(llm, 'local:srv-o1:tiny:1b', [weatherTool(async () => 'unused')])).toBe('Hi.');
    expect(notices).toEqual([
      'The CLI could not check whether tiny:1b on shared supports tools, so it chats with it without tools. Start a new b4m session to check again.',
    ]);
  });

  it('stops a reply mid-stream when the turn is aborted', async () => {
    const fake = await ollama(undefined, {
      'POST /api/chat': (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.write(
          `${JSON.stringify({ model: 'tiny:1b', message: { role: 'assistant', content: 'Hel' }, done: false })}\n`
        );
      },
    });
    await writeServers([record({ id: 'o1', name: 'shared', transport: { type: 'http', baseUrl: fake.baseUrl } })]);
    const { llm } = await attach({ defaultModel: 'local:srv-o1:tiny:1b' }, { servers: 'default' });
    const controller = new AbortController();
    let text = '';
    const turn = llm.complete(
      'local:srv-o1:tiny:1b',
      user('hi'),
      { stream: true, abortSignal: controller.signal },
      async parts => {
        text += parts.filter(Boolean).join('');
        controller.abort();
      }
    );
    await expect(turn).rejects.toThrow(/abort/i);
    expect(text).toBe('Hel');
  });

  it('fails with the login hint when the default is on a server that needs credentials', async () => {
    const fake = await ollama(TOKEN);
    await writeServers([lockedRecord(fake)]);
    const failure = attach({ defaultModel: 'local:srv-o1:tiny:1b' }, { servers: 'default' });
    await expect(failure).rejects.toThrow(
      'Cannot chat with tiny:1b on locked: locked needs credentials. Run: b4m models servers login locked'
    );
    await expect(failure).rejects.toThrow('The CLI does not switch to another model on its own.');
    expect(fake.requests).toEqual([]);
  });

  it('fails with the login hint, and no token, when the server refuses the saved credential', async () => {
    const fake = await ollama(TOKEN);
    await writeServers([lockedRecord(fake)]);
    const failure = attach({
      defaultModel: 'local:srv-o1:tiny:1b',
      modelServerCredentials: { o1: { secret: 'tok-wrong-0000000000' } },
    });
    await expect(failure).rejects.toThrow('locked refused the saved credentials. Run: b4m models servers login locked');
    await expect(failure).rejects.not.toThrow('tok-wrong');
  });

  it('fails naming the server when the default is on a server that is down', async () => {
    const port = await closedPort();
    await writeServers([downRecord('o1', 'gpu-box', port)]);
    await expect(attach({ defaultModel: 'local:srv-o1:tiny:1b' }, { servers: 'default' })).rejects.toThrow(
      /^Cannot chat with tiny:1b on gpu-box: .*gpu-box/
    );
  });

  it('fails when the server answers but no longer serves the default model', async () => {
    const fake = await vllm();
    await writeServers([vllmRecord('s1', 'vllm', fake)]);
    await expect(attach({ defaultModel: 'local:srv-s1:gone' })).rejects.toThrow(
      'Cannot chat with gone on vllm: vllm does not serve it. See: b4m models ls --server vllm'
    );
  });

  it('starts without waiting on other servers, adds those that answer, and skips the rest without a warning', async () => {
    const fake = await vllm();
    const locked = await ollama(TOKEN);
    const port = await closedPort();
    const stalled = await silentServer();
    await writeServers([
      vllmRecord('s1', 'vllm', fake),
      lockedRecord(locked),
      downRecord('o2', 'gone', port),
      record({ id: 'o3', name: 'stalled', transport: { type: 'http', baseUrl: stalled.baseUrl } }),
    ]);
    const added: ModelInfo[][] = [];
    const started = performance.now();
    const attached = await attach({}, { servers: 'all', listingTimeoutMs: 400, onModelsAdded: m => added.push(m) });
    expect(attached.models).toEqual([hosted]);
    expect(attached.warnings).toEqual([]);
    expect(performance.now() - started).toBeLessThan(400);
    await attached.later;
    expect(added).toHaveLength(1);
    expect(added[0].map(model => model.id)).toEqual(['hosted-1', ...VLLM_IDS]);
    expect(locked.requests).toEqual([]);
    expect(attached.warnings).toEqual([]);
  });

  it('fails naming the server when the default is on a server that accepts the connection and never answers', async () => {
    const stalled = await silentServer();
    await writeServers([record({ id: 'o1', name: 'gpu-box', transport: { type: 'http', baseUrl: stalled.baseUrl } })]);
    const failure = attach({ defaultModel: 'local:srv-o1:tiny:1b' }, { servers: 'all', defaultServerTimeoutMs: 300 });
    await expect(failure).rejects.toThrow(/^Cannot chat with tiny:1b on gpu-box: /);
    await expect(failure).rejects.toThrow('The CLI does not switch to another model on its own.');
  });

  it.each([
    ['default', { defaultModel: 'local:srv-o1:tiny:1b' }],
    ['optional', {}],
  ])('stops waiting on a %s server that sends headers and then stalls', async (_role, config) => {
    const stalled = await silentServer(true);
    await writeServers([record({ id: 'o1', name: 'gpu-box', transport: { type: 'http', baseUrl: stalled.baseUrl } })]);
    const started = performance.now();
    const attaching = attach(config, { servers: 'all', listingTimeoutMs: 300, defaultServerTimeoutMs: 300 });
    if ('defaultModel' in config) {
      // The probe's own timeout and the startup deadline are both 0.3s here; either may report first.
      await expect(attaching).rejects.toThrow(
        /^Cannot chat with tiny:1b on gpu-box: (no answer within 0\.3s|Could not reach gpu-box)/
      );
    } else {
      const attached = await attaching;
      await attached.later;
      expect(await attached.llm.getModelInfo()).toEqual([hosted]);
    }
    expect(performance.now() - started).toBeLessThan(2_000);
    await vi.waitFor(() => expect(stalled.open()).toBe(0));
  });

  it('gives the default model server longer than the others to answer', async () => {
    const slow = await ollama(undefined, {
      'GET /api/version': (_request, response) => {
        setTimeout(() => json({ version: '0.12.0' })(_request, response), 600);
      },
    });
    await writeServers([record({ id: 'o1', name: 'slow', transport: { type: 'http', baseUrl: slow.baseUrl } })]);
    const attached = await attach(
      { defaultModel: 'local:srv-o1:tiny:1b' },
      { servers: 'all', listingTimeoutMs: 200, defaultServerTimeoutMs: 5_000 }
    );
    expect(attached.servers).toEqual([{ name: 'slow', modelCount: 1 }]);
  });

  it('headless with a server default probes only that server when others are saved', async () => {
    const owner = await vllm();
    const other = await ollama();
    await writeServers([
      vllmRecord('s1', 'vllm', owner),
      record({ id: 'o1', name: 'shared', transport: { type: 'http', baseUrl: other.baseUrl } }),
    ]);
    const attached = await attach({ defaultModel: 'local:srv-s1:qwen-small' }, { servers: 'default' });
    await attached.later;
    expect(attached.models.map(model => model.id)).toEqual(['hosted-1', ...VLLM_IDS]);
    expect(other.requests).toEqual([]);
  });

  it('uses a plain Ollama host alongside saved model servers', async () => {
    const plain = await ollama();
    const saved = await vllm();
    await writeServers([vllmRecord('s1', 'vllm', saved)]);
    const attached = await attach({ defaultModel: 'tiny:1b' }, { servers: 'all', ollamaHost: plain.baseUrl });
    await attached.later;
    expect(attached.ollamaModelCount).toBe(1);
    const ids = (await attached.llm.getModelInfo()).map(model => model.id);
    expect(ids).toEqual(['hosted-1', 'tiny:1b', ...VLLM_IDS]);
    expect(await chat(attached.llm, 'tiny:1b')).toBe('Hi.');
    expect(await chat(attached.llm, 'local:srv-s1:qwen-small')).toBe('Hello.');
    expect(plain.requests.filter(request => request.path === '/api/chat')).toHaveLength(1);
    expect(saved.requests).toHaveLength(1);
  });

  it('headless with a hosted default reads no model servers', async () => {
    const load = vi.fn(deps.loadModelServers!);
    const attached = await attachLocalModels(
      serverBackend() as never,
      createMockConfig({ defaultModel: 'hosted-1' }),
      { servers: 'default' },
      { ...deps, loadModelServers: load }
    );
    expect(load).not.toHaveBeenCalled();
    expect(attached.models).toEqual([hosted]);
  });
});
