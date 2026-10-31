import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelBackend, type IMessage } from '@bike4mind/common';
import { createServerFetch, type FetchLike } from '@bike4mind/local-models/servers';
import {
  json,
  sendJson,
  startFakeServer,
  startFakeVllm,
  type FakeServer,
  type FakeVllm,
  type RecordedRequest,
} from '@bike4mind/local-models/testing';
import type { ServerResponse } from 'node:http';
import type { CompletionInfo, ICompletionOptionTools } from './backend';
import { OpenAICompatibleBackend } from './openaiCompatibleBackend';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as never;
const userMessage = (content: string) => [{ role: 'user', content }] as unknown as IMessage[];

const weatherTool = (toolFn: ICompletionOptionTools['toolFn'], padding = 0): ICompletionOptionTools => ({
  toolFn,
  toolSchema: {
    name: 'get_weather',
    description: 'Current weather for a city.' + ' x'.repeat(padding),
    parameters: { type: 'object', properties: { city: { type: 'string', description: 'City' } }, required: ['city'] },
  },
});

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.map(close => close()));
  closers = [];
});

async function vllm(options: { toolFlags?: boolean; maxModelLen?: number } = {}): Promise<FakeVllm> {
  const fake = await startFakeVllm(options);
  closers.push(() => fake.close());
  return fake;
}

async function fakeServer(routes: Parameters<typeof startFakeServer>[0]): Promise<FakeServer> {
  const server = await startFakeServer(routes);
  closers.push(() => server.close());
  return server;
}

function make(
  baseUrl: string,
  product: 'vllm' | 'llama-server' | 'lmstudio' | null,
  fetch: FetchLike = globalThis.fetch
) {
  const notices: string[] = [];
  const backend = new OpenAICompatibleBackend({
    baseUrl,
    label: 'gpu-box',
    product,
    fetch,
    logger: silentLogger,
    onNotice: text => notices.push(text),
  });
  return { backend, notices };
}

async function run(
  backend: OpenAICompatibleBackend,
  model: string,
  tools: ICompletionOptionTools[] = [],
  prompt = 'hi'
): Promise<{ text: string; info?: CompletionInfo }> {
  let text = '';
  let info: CompletionInfo | undefined;
  await backend.complete(model, userMessage(prompt), { stream: true, tools }, async (parts, completion) => {
    text += parts.filter(Boolean).join('');
    info = completion;
  });
  return { text, info };
}

const bodyOf = (request: RecordedRequest) =>
  JSON.parse(request.body || '{}') as { stream?: boolean; tools?: unknown[]; messages?: { role: string }[] };

function sse(response: ServerResponse, deltas: object[], usage = { prompt_tokens: 3, completion_tokens: 2 }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  deltas.forEach((delta, i) =>
    response.write(
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: i === deltas.length - 1 ? 'stop' : null }] })}\n\n`
    )
  );
  response.write(
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [], usage })}\n\n`
  );
  response.end('data: [DONE]\n\n');
}

describe('OpenAICompatibleBackend against vLLM', () => {
  it('streams text and reports usage', async () => {
    const fake = await vllm({ maxModelLen: 32768 });
    const { backend } = make(fake.baseUrl, 'vllm');
    const { text, info } = await run(backend, 'qwen-small');
    expect(text).toBe('Hello.');
    expect(info?.outputTokens).toBe(20);
    expect(fake.requests[0]).not.toHaveProperty('tools');
  });

  it('accepts an alias and sends the canonical name', async () => {
    const fake = await vllm({ maxModelLen: 32768 });
    const { backend } = make(fake.baseUrl, 'vllm');
    await backend.getModelInfo();
    await run(backend, 'qwen');
    expect(fake.requests[0].model).toBe('qwen-small');
  });

  it('round-trips a tool call', async () => {
    const fake = await vllm({ maxModelLen: 32768 });
    const toolFn = vi.fn(async () => '21C');
    const { backend, notices } = make(fake.baseUrl, 'vllm');
    const { text } = await run(backend, 'qwen-small', [weatherTool(toolFn)]);
    expect(toolFn).toHaveBeenCalledWith({ city: 'Paris' });
    expect(text).toBe('It is 21C in Paris.');
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0].tools).toHaveLength(1);
    const second = fake.requests[1] as { messages: { role: string; tool_call_id?: string }[] };
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'chatcmpl-tool-9a2b' });
    expect(notices).toEqual([]);
  });

  it('retries without tools when the server refuses them, with one notice', async () => {
    const fake = await vllm({ toolFlags: false, maxModelLen: 32768 });
    const toolFn = vi.fn(async () => 'unused');
    const { backend, notices } = make(fake.baseUrl, 'vllm');
    const first = await run(backend, 'qwen-small', [weatherTool(toolFn)]);
    expect(first.text).toBe('Hello.');
    expect(toolFn).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('--enable-auto-tool-choice');
    expect(notices[0]).toContain('start a new b4m session');

    const requestsBefore = fake.requests.length;
    await run(backend, 'qwen-small', [weatherTool(toolFn)]);
    expect(fake.requests).toHaveLength(requestsBefore + 1);
    expect(notices).toHaveLength(1);
    const [info] = await backend.getModelInfo();
    expect(info.supportsTools).toBe(false);
  });

  it('reads a refusal from a flat error body', async () => {
    const refusal = '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set';
    const server = await fakeServer({
      'POST /v1/chat/completions': (req, res) =>
        bodyOf(req).tools
          ? sendJson(res, { object: 'error', message: refusal, type: 'BadRequestError', code: 400 }, 400)
          : sse(res, [{ content: 'Hello.' }]),
    });
    const { backend, notices } = make(server.baseUrl, 'vllm');
    const { text } = await run(backend, 'm', [weatherTool(async () => '')]);
    expect(text).toBe('Hello.');
    expect(notices).toHaveLength(1);
  });

  it('keeps the message of a flat error body that is not a refusal', async () => {
    const server = await fakeServer({
      'POST /v1/chat/completions': json({ object: 'error', message: 'The model `m` does not exist.', code: 404 }, 404),
    });
    const { backend } = make(server.baseUrl, 'vllm');
    await expect(run(backend, 'm')).rejects.toThrow(/^gpu-box returned HTTP 404: The model `m` does not exist\.$/);
  });

  it('keeps the message of a plain-text error body', async () => {
    const server = await fakeServer({
      'POST /v1/chat/completions': (_req, res) => {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('upstream down');
      },
    });
    const { backend } = make(server.baseUrl, null);
    await expect(run(backend, 'm')).rejects.toThrow(/^gpu-box returned HTTP 502: upstream down$/);
  });

  it('keeps tools on when a tool-shaped error is not a refusal', async () => {
    let turns = 0;
    const server = await fakeServer({
      'POST /v1/chat/completions': (req, res) => {
        const body = bodyOf(req);
        if (!body.stream) return sendJson(res, { choices: [{ index: 0, message: { content: 'p' } }] });
        if (turns++ === 0)
          return sendJson(
            res,
            {
              object: 'error',
              message: "messages with role 'tool' must be a response to a preceeding message with 'tool_calls'",
            },
            400
          );
        return sse(res, [{ content: 'ok' }]);
      },
    });
    const { backend, notices } = make(server.baseUrl, 'vllm');
    const tools = [weatherTool(async () => '')];
    await expect(run(backend, 'm', tools)).rejects.toThrow(/HTTP 400: messages with role 'tool' must be/);
    expect(notices).toEqual([]);
    expect((await run(backend, 'm', tools)).text).toBe('ok');
    const chats = server.requests.map(bodyOf).filter(body => body.stream);
    expect(chats).toHaveLength(2);
    expect(chats[1].tools).toHaveLength(1);
  });

  it('sends no tools when the context cannot hold them, with one notice', async () => {
    const fake = await vllm({ maxModelLen: 4096 });
    const { backend, notices } = make(fake.baseUrl, 'vllm');
    const tools = [weatherTool(async () => '', 9000)];
    const { text } = await run(backend, 'qwen-small', tools);
    expect(text).toBe('Hello.');
    expect(fake.requests[0]).not.toHaveProperty('tools');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('--max-model-len 16384');
    await run(backend, 'qwen-small', tools);
    expect(notices).toHaveLength(1);
  });

  it('lists aliases once and names an adapter with its base', async () => {
    const fake = await vllm({ maxModelLen: 32768 });
    const { backend } = make(fake.baseUrl, 'vllm');
    const infos = await backend.getModelInfo();
    expect(infos.map(info => info.id)).toEqual(['qwen-small', 'sql-lora']);
    expect(infos[1].name).toBe('sql-lora (LoRA on qwen-small)');
    expect(infos[0]).toMatchObject({
      backend: ModelBackend.OpenAICompatible,
      contextWindow: 32768,
      supportsTools: true,
      freeToRun: true,
    });
  });

  it('reports a 401 without any body text', async () => {
    const server = await fakeServer({
      'POST /v1/chat/completions': (_req, res) => sendJson(res, { error: { message: 'bad token s3cret-token' } }, 401),
    });
    const { backend } = make(server.baseUrl, null);
    await expect(run(backend, 'm')).rejects.toThrow(/^gpu-box needs credentials\.$/);
  });

  it('keeps the credential out of other HTTP errors and drops the SDK authorization', async () => {
    const server = await fakeServer({
      'POST /v1/chat/completions': (req, res) =>
        sendJson(res, { error: { message: `bad request, saw ${String(req.headers.authorization)}` } }, 400),
    });
    const fetch = createServerFetch({
      origin: server.baseUrl,
      label: 'gpu-box',
      app: 'the CLI',
      credentialHeaders: () => ({ authorization: 'Bearer s3cret-token' }),
    });
    const { backend } = make(server.baseUrl, null, fetch);
    const error = await run(backend, 'm').catch((e: Error) => e);
    expect((error as Error).message).toMatch(/^gpu-box returned HTTP 400: bad request, saw /);
    expect((error as Error).message).not.toContain('s3cret-token');
    expect(server.requests[0].headers.authorization).toBe('Bearer s3cret-token');
  });

  it('streams reasoning_content and reasoning as think text', async () => {
    for (const field of ['reasoning_content', 'reasoning']) {
      const server = await fakeServer({
        'POST /v1/chat/completions': (_req, res) =>
          sse(res, [{ [field]: 'hmm ' }, { [field]: 'ok' }, { content: 'Answer.' }]),
      });
      const { backend } = make(server.baseUrl, null);
      const { text } = await run(backend, 'm');
      expect(text).toBe('<think>hmm ok</think>Answer.');
    }
  });
});

describe('OpenAICompatibleBackend against other servers', () => {
  it('chats with llama-server and reads its context from /props', async () => {
    const server = await fakeServer({
      'GET /v1/models': json({ object: 'list', data: [{ id: 'model.gguf', owned_by: 'llamacpp', meta: { size: 5 } }] }),
      'GET /props': json({ default_generation_settings: { n_ctx: 8192 } }),
      'POST /v1/chat/completions': (_req, res) => sse(res, [{ role: 'assistant', content: 'pong' }]),
    });
    const { backend } = make(server.baseUrl, 'llama-server');
    const [info] = await backend.getModelInfo();
    expect(info.contextWindow).toBe(8192);
    expect((await run(backend, 'model.gguf')).text).toBe('pong');
  });

  it('chats with an LM Studio shaped server', async () => {
    const server = await fakeServer({
      'GET /api/v0/models': json({ object: 'list', data: [{ id: 'qwen-7b', type: 'llm', arch: 'qwen2' }] }),
      'POST /v1/chat/completions': (_req, res) => sse(res, [{ role: 'assistant', content: 'hello' }]),
    });
    const { backend } = make(server.baseUrl, 'lmstudio');
    const [info] = await backend.getModelInfo();
    expect(info).toMatchObject({ id: 'qwen-7b', contextWindow: 16384 });
    expect((await run(backend, 'qwen-7b')).text).toBe('hello');
  });
});
