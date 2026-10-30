import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@bike4mind/local-models';
import type { SecretCipher, StoreFile } from '../chat/mcp/McpServerStore';
import type { CompletionRequest } from '../chat/completions';
import type { CompletionStreamEvent } from '../chat/streamEvents';
import { ModelServerRegistry } from './ModelServerRegistry';
import { ModelServerStore } from './ModelServerStore';
import { contextTooSmallHint, OpenAICompatibleChat } from './OpenAICompatibleChat';

/**
 * A vLLM stand-in that answers with vLLM's own shapes: ModelCard and ErrorResponse from
 * vllm/entrypoints/serve/engine/protocol.py, the tool-choice refusal from vllm/renderers/online_renderer.py, and
 * the chunk sequence `vllm serve --enable-auto-tool-choice --tool-call-parser hermes` streams for a tool call.
 */
interface FakeVllm {
  baseUrl: string;
  /** Restarts it with or without `--enable-auto-tool-choice --tool-call-parser hermes`. */
  toolFlags: boolean;
  /** Restarts it with another `--max-model-len`. */
  maxModelLen: number;
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

const SERVED = ['qwen-small', 'qwen'];
const ROOT = '/models/Qwen2.5-0.5B-Instruct';
const MAX_MODEL_LEN = 4096;
const REFUSAL = '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set';

function modelList(maxModelLen: number) {
  const created = Math.floor(Date.now() / 1000);
  const card = (id: string, root: string, parent: string | null, maxModelLen: number | null) => ({
    id,
    object: 'model',
    created,
    owned_by: 'vllm',
    root,
    parent,
    max_model_len: maxModelLen,
    permission: [{ id: `modelperm-${id}`, object: 'model_permission', created, allow_create_engine: false }],
  });
  return {
    object: 'list',
    data: [
      ...SERVED.map(name => card(name, ROOT, null, maxModelLen)),
      card('sql-lora', '/adapters/sql-lora', SERVED[0], null),
    ],
  };
}

function chunk(model: string, delta: object, finish: string | null = null) {
  return {
    id: 'chatcmpl-4f1c',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
  };
}

async function startFakeVllm(): Promise<FakeVllm> {
  const fake = { toolFlags: true, maxModelLen: MAX_MODEL_LEN, requests: [] as Record<string, unknown>[] };
  const server: Server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part as Buffer);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/v1/models') return send(200, modelList(fake.maxModelLen));
    if (req.method === 'GET' && req.url === '/version') return send(200, { version: '0.32.0' });
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, { detail: 'Not Found' });
    const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as {
      model: string;
      stream?: boolean;
      tools?: unknown[];
      tool_choice?: unknown;
      messages: { role: string }[];
    };
    fake.requests.push(body);
    if (![...SERVED, 'sql-lora'].includes(body.model))
      return send(404, {
        error: {
          message: `The model \`${body.model}\` does not exist.`,
          type: 'NotFoundError',
          param: 'model',
          code: 404,
        },
      });
    if (body.tools?.length && !fake.toolFlags && (body.tool_choice ?? 'auto') === 'auto')
      return send(400, { error: { message: REFUSAL, type: 'BadRequestError', param: null, code: 400 } });
    if (!body.stream)
      return send(200, {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'p' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 160, completion_tokens: 1, total_tokens: 161 },
      });
    const frames: object[] = [chunk(body.model, { role: 'assistant', content: '' })];
    if (body.messages.at(-1)?.role === 'tool') {
      frames.push(chunk(body.model, { content: 'It is 21C ' }), chunk(body.model, { content: 'in Paris.' }, 'stop'));
    } else if (body.tools?.length) {
      frames.push(
        chunk(body.model, {
          tool_calls: [{ id: 'chatcmpl-tool-9a2b', type: 'function', index: 0, function: { name: 'get_weather' } }],
        }),
        chunk(body.model, { tool_calls: [{ index: 0, function: { arguments: '{"city": "' } }] }),
        chunk(body.model, { tool_calls: [{ index: 0, function: { arguments: 'Paris"}' } }] }),
        chunk(body.model, { content: '' }, 'tool_calls')
      );
    } else {
      frames.push(chunk(body.model, { content: 'Hello.' }, 'stop'));
    }
    frames.push({
      id: 'chatcmpl-4f1c',
      object: 'chat.completion.chunk',
      model: body.model,
      choices: [],
      usage: { prompt_tokens: 210, total_tokens: 230, completion_tokens: 20 },
    });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  });
}

const fetchLike: FetchLike = (input, init) => fetch(input, init);
const texts = (events: readonly CompletionStreamEvent[]) =>
  events.flatMap(event => (event.type === 'content' && event.text ? [event.text] : []));
const RUNTIME = 'srv-vllm01';
const id = (name: string) => `local:${RUNTIME}:${name}`;
const WEATHER_TOOL = {
  toolSchema: {
    name: 'get_weather',
    description: 'Current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

let vllm: FakeVllm | undefined;
afterEach(async () => {
  await vllm?.close();
  vllm = undefined;
});

function client(server: FakeVllm, toolsChanged = vi.fn()) {
  return new OpenAICompatibleChat({
    runtimeId: RUNTIME,
    baseUrl: server.baseUrl,
    label: 'gpu vllm',
    product: 'vllm',
    fetch: fetchLike,
    hasCredentials: () => false,
    redact: text => text,
    toolsChanged,
  });
}

async function turn(chat: OpenAICompatibleChat, request: CompletionRequest, notices: string[] = []) {
  const events: CompletionStreamEvent[] = [];
  await chat.stream(
    request,
    event => events.push(event),
    undefined,
    undefined,
    message => notices.push(message)
  );
  return events;
}

describe('OpenAICompatibleChat against vLLM', () => {
  it('lists served-name aliases once and an adapter with its base, sized by max_model_len', async () => {
    vllm = await startFakeVllm();
    const chat = client(vllm);
    const models = await chat.listModels();
    expect(models.map(({ name, contextWindow, baseModel }) => ({ name, contextWindow, baseModel }))).toEqual([
      { name: 'qwen-small', contextWindow: MAX_MODEL_LEN, baseModel: undefined },
      { name: 'sql-lora', contextWindow: MAX_MODEL_LEN, baseModel: 'qwen-small' },
    ]);
    expect(models.every(model => model.supportsTools === undefined)).toBe(true);
    expect(models.map(model => model.aliasIds)).toEqual([[models[0].id.replace(/qwen-small$/, 'qwen')], undefined]);
  });

  it('takes the context from max_model_len before any listing, for the first name, an alias and an adapter', async () => {
    vllm = await startFakeVllm();
    for (const name of ['qwen-small', 'qwen', 'sql-lora'])
      expect(await client(vllm).contextTokens(id(name))).toBe(4096);
  });

  it('round-trips a tool call: streamed tool_calls, the tool result sent back, then the answer', async () => {
    vllm = await startFakeVllm();
    const chat = client(vllm);
    const ask: CompletionRequest = {
      model: id('qwen-small'),
      messages: [{ role: 'user', content: 'Weather in Paris?' }],
      tools: [WEATHER_TOOL],
      sessionId: 's1',
    };
    const first = await turn(chat, ask);
    expect(first).toEqual([
      {
        type: 'tool_use',
        tools: [{ name: 'get_weather', arguments: '{"city": "Paris"}', id: 'chatcmpl-tool-9a2b' }],
      },
      { type: 'content', stopReason: 'tool_use', usage: { inputTokens: 210, outputTokens: 20 } },
    ]);
    const second = await turn(chat, {
      ...ask,
      messages: [
        ...ask.messages,
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'chatcmpl-tool-9a2b', name: 'get_weather', input: { city: 'Paris' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'chatcmpl-tool-9a2b', content: '21C, clear' }],
        },
      ],
    });
    expect(texts(second)).toEqual(['It is 21C ', 'in Paris.']);
    expect(second.at(-1)).toMatchObject({ stopReason: 'stop' });
    expect(vllm.requests[1]).toMatchObject({
      model: 'qwen-small',
      tools: [{ type: 'function', function: WEATHER_TOOL.toolSchema }],
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'chatcmpl-tool-9a2b',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'chatcmpl-tool-9a2b', content: '21C, clear' },
      ],
    });
  });

  it('chats without tools when started without tool flags, says why once per conversation, and lists tools off', async () => {
    vllm = await startFakeVllm();
    vllm.toolFlags = false;
    const toolsChanged = vi.fn();
    const chat = client(vllm, toolsChanged);
    const notices: string[] = [];
    const ask: CompletionRequest = {
      model: id('qwen-small'),
      messages: [{ role: 'user', content: 'hi' }],
      tools: [WEATHER_TOOL],
      sessionId: 's1',
    };
    const events = await turn(chat, ask, notices);
    expect(texts(events)).toEqual(['Hello.']);
    await turn(chat, ask, notices);
    await turn(chat, { ...ask, tools: [], sessionId: 's2' }, notices);
    expect(vllm.requests.map(request => 'tools' in request)).toEqual([true, false, false, false]);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(/gpu vllm was started without tool calling/);
    expect(notices[0]).toContain('--enable-auto-tool-choice');
    expect(notices[0]).toContain('--tool-call-parser');
    expect(toolsChanged).toHaveBeenCalledTimes(1);
    expect(chat.toolsHint()).toBe(notices[0]);
    expect((await chat.listModels()).map(model => model.supportsTools)).toEqual([false, false]);
  });

  it('turns tools back on at the recheck after vLLM restarts with tool flags', async () => {
    vllm = await startFakeVllm();
    vllm.toolFlags = false;
    const toolsChanged = vi.fn();
    const chat = client(vllm, toolsChanged);
    const ask: CompletionRequest = {
      model: id('qwen-small'),
      messages: [{ role: 'user', content: 'hi' }],
      tools: [WEATHER_TOOL],
      sessionId: 's1',
    };
    await turn(chat, ask);
    await chat.recheckTools('qwen-small');
    expect(chat.toolsHint()).not.toBeNull();

    vllm.toolFlags = true;
    await chat.recheckTools('qwen-small');
    const probe = vllm.requests.at(-1);
    expect(probe).toMatchObject({ model: 'qwen-small', max_tokens: 1, tools: [{ type: 'function' }] });
    expect(probe?.stream).toBeUndefined();
    expect(chat.toolsHint()).toBeNull();
    expect(toolsChanged).toHaveBeenCalledTimes(2);
    expect((await chat.listModels()).every(model => model.supportsTools === undefined)).toBe(true);
    const events = await turn(chat, ask);
    expect(events[0]).toMatchObject({ type: 'tool_use' });
  });

  it('turns tools off on the next chat after vLLM restarts without tool flags', async () => {
    vllm = await startFakeVllm();
    const chat = client(vllm);
    const ask: CompletionRequest = {
      model: id('qwen-small'),
      messages: [{ role: 'user', content: 'hi' }],
      tools: [WEATHER_TOOL],
      sessionId: 's1',
    };
    expect((await turn(chat, ask))[0]).toMatchObject({ type: 'tool_use' });
    vllm.toolFlags = false;
    const notices: string[] = [];
    const events = await turn(chat, ask, notices);
    expect(texts(events)).toEqual(['Hello.']);
    expect(notices).toHaveLength(1);
  });

  it('asks a vLLM server once whether it takes tools, before any chat', async () => {
    vllm = await startFakeVllm();
    const chat = client(vllm);
    await chat.recheckTools('qwen-small');
    await chat.recheckTools('qwen-small');
    expect(vllm.requests).toHaveLength(1);
    expect(chat.toolsHint()).toBeNull();

    vllm.toolFlags = false;
    const fresh = client(vllm);
    await fresh.recheckTools('qwen-small');
    expect(fresh.toolsHint()).toMatch(/started without tool calling/);
  });
});

describe('OpenAICompatibleChat when the context is too small for Desktop prompt and tools', () => {
  const ask = (sessionId: string, toolPromptTokens?: number): CompletionRequest => ({
    model: `local:${RUNTIME}:qwen-small`,
    messages: [{ role: 'user', content: 'Say hello.' }],
    sessionId,
    ...(toolPromptTokens !== undefined ? { toolPromptTokens } : {}),
  });

  it('says why once per conversation, lists tools off, and names --max-model-len; a larger one turns them back on', async () => {
    vllm = await startFakeVllm();
    const toolsChanged = vi.fn();
    const chat = client(vllm, toolsChanged);
    expect(
      (await chat.listModels()).map(model => [model.contextWindow, model.contextFixed, model.supportsTools])
    ).toEqual([
      [MAX_MODEL_LEN, true, undefined],
      [MAX_MODEL_LEN, true, undefined],
    ]);
    expect(chat.toolsHint()).toBeNull();

    const notices: string[] = [];
    expect(texts(await turn(chat, ask('a', 9_000), notices))).toEqual(['Hello.']);
    await turn(chat, ask('a'), notices);
    await turn(chat, ask('b'), notices);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(/qwen-small with a 4096-token context.*about 9000 tokens.*--max-model-len 16384/);
    expect(notices[0]).not.toMatch(/--enable-auto-tool-choice/);
    expect(toolsChanged).toHaveBeenCalledTimes(1);
    expect((await chat.listModels()).map(model => model.supportsTools)).toEqual([false, false]);
    expect(chat.toolsHint()).toMatch(/runs qwen-small, sql-lora with a 4096-token context/);

    vllm.maxModelLen = 16_384;
    expect((await chat.listModels()).map(model => model.supportsTools)).toEqual([undefined, undefined]);
    expect(chat.toolsHint()).toBeNull();
    expect(toolsChanged).toHaveBeenCalledTimes(2);
    await turn(chat, ask('c'), notices);
    expect(notices).toHaveLength(2);
  });

  it('keeps tools on and says nothing when the context holds the prompt', async () => {
    vllm = await startFakeVllm();
    vllm.maxModelLen = 16_384;
    const toolsChanged = vi.fn();
    const chat = client(vllm, toolsChanged);
    await chat.listModels();
    const notices: string[] = [];
    await turn(chat, { ...ask('a'), tools: [WEATHER_TOOL] }, notices);
    expect(notices).toEqual([]);
    expect(vllm.requests.at(-1)?.tools).toHaveLength(1);
    expect(chat.toolsHint()).toBeNull();
    expect(toolsChanged).not.toHaveBeenCalled();
  });

  it('names the larger --max-model-len a bigger prompt needs', () => {
    expect(contextTooSmallHint('gpu', 'vllm', [{ name: 'm', context: 8192 }], 15_000)).toMatch(/--max-model-len 32768/);
    expect(contextTooSmallHint('gpu', 'llama-server', [{ name: 'm', context: 4096 }], 9_000)).toMatch(
      /--ctx-size 16384/
    );
  });
});

describe('ModelServerRegistry with a vLLM server', () => {
  const cipher: SecretCipher = {
    isEncryptionAvailable: () => true,
    encryptString: plain => Buffer.from(plain, 'utf8'),
    decryptString: encrypted => encrypted.toString('utf8'),
  };
  const memoryFile = (): StoreFile => {
    let contents: string | null = null;
    return {
      read: async () => contents,
      write: async next => {
        contents = next;
      },
    };
  };

  it('shows the tools hint on the server row and clears it at the check after a restart with flags', async () => {
    vllm = await startFakeVllm();
    vllm.toolFlags = false;
    const quiet = { debug: () => undefined, warn: () => undefined };
    const changed = vi.fn();
    const servers = new ModelServerRegistry({
      store: new ModelServerStore(cipher, memoryFile(), quiet),
      logger: quiet,
      changed,
      fetchFor: () => fetchLike,
      localFetch: async () => new Response('{"version":"0.12.0"}'),
      resolve: async () => ['127.0.0.1'],
    });
    const views = await servers.add({
      address: vllm.baseUrl,
      credential: { type: 'none' },
      name: 'gpu vllm',
      kind: 'openai-compatible',
      access: 'chat',
    });
    expect(views[1]).toMatchObject({
      health: { state: 'online', version: '0.32.0' },
      models: ['qwen-small', 'sql-lora'],
    });
    await vi.waitFor(async () => expect((await servers.views())[1].toolsHint).toMatch(/started without tool calling/));
    const listed = await servers.models();
    expect(listed.map(model => [model.name, model.baseModel, model.supportsTools])).toEqual([
      ['qwen-small', undefined, false],
      ['sql-lora', 'qwen-small', false],
    ]);

    vllm.toolFlags = true;
    await servers.check(views[1].id);
    await vi.waitFor(async () => expect((await servers.views())[1].toolsHint).toBeUndefined());
    expect(changed).toHaveBeenCalled();
  });

  it('keeps the alias ids on the listed model while the server is down', async () => {
    vllm = await startFakeVllm();
    const quiet = { debug: () => undefined, warn: () => undefined };
    const servers = new ModelServerRegistry({
      store: new ModelServerStore(cipher, memoryFile(), quiet),
      logger: quiet,
      fetchFor: () => fetchLike,
      localFetch: async () => new Response('{"version":"0.12.0"}'),
      resolve: async () => ['127.0.0.1'],
    });
    const views = await servers.add({
      address: vllm.baseUrl,
      credential: { type: 'none' },
      name: 'gpu vllm',
      kind: 'openai-compatible',
      access: 'chat',
    });
    const online = (await servers.models()).find(model => model.name === 'qwen-small');
    expect(online?.aliasIds).toEqual([online?.id.replace(/qwen-small$/, 'qwen')]);

    await vllm.close();
    vllm = undefined;
    await servers.check(views[1].id);
    const down = (await servers.models()).find(model => model.name === 'qwen-small');
    expect(down).toMatchObject({ id: online?.id, aliasIds: online?.aliasIds, unavailable: expect.any(String) });
  });
});
