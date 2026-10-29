import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@bike4mind/local-models';
import type { CompletionStreamEvent } from '../chat/streamEvents';
import { ServerCredentialsError } from './errors';
import { OpenAICompatibleChat, toOpenAIMessages } from './OpenAICompatibleChat';

const BASE = 'http://127.0.0.1:18080';
const MODEL = 'local:srv-abc123:qwen2.5-0.5b';

function sse(frames: readonly (object | string)[]): Response {
  const text = frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function chat(fetch: FetchLike, product: 'llama-server' | null = 'llama-server') {
  return new OpenAICompatibleChat({
    runtimeId: 'srv-abc123',
    baseUrl: BASE,
    label: 'llama box',
    product,
    fetch,
    hasCredentials: () => false,
  });
}

async function collect(client: OpenAICompatibleChat, request: Parameters<OpenAICompatibleChat['stream']>[0]) {
  const events: CompletionStreamEvent[] = [];
  await client.stream(request, event => events.push(event));
  return events;
}

const delta = (content: object, finish: string | null = null) => ({
  choices: [{ delta: content, finish_reason: finish }],
});

describe('OpenAICompatibleChat', () => {
  it('streams text, reasoning and usage, and sends the bare model name', async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      sse([
        delta({ reasoning_content: 'thinking' }),
        delta({ content: 'Hel' }),
        delta({ content: 'lo' }, 'stop'),
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
        '[DONE]',
      ])
    );
    const events = await collect(chat(fetch), {
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
    });
    expect(events).toEqual([
      { type: 'content', text: '<think>thinking</think>' },
      { type: 'content', text: 'Hel' },
      { type: 'content', text: 'lo' },
      { type: 'content', stopReason: 'stop', usage: { inputTokens: 12, outputTokens: 3 } },
    ]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/chat/completions`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'qwen2.5-0.5b', stream: true, max_tokens: 64 });
  });

  it('assembles tool calls split across frames', async () => {
    const fetch: FetchLike = async () =>
      sse([
        delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_', arguments: '{"pa' } }] }),
        delta({ tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a"}' } }] }, 'tool_calls'),
        '[DONE]',
      ]);
    const events = await collect(chat(fetch), { model: MODEL, messages: [{ role: 'user', content: 'read a' }] });
    expect(events).toEqual([
      { type: 'tool_use', tools: [{ name: 'read_file', arguments: '{"path":"a"}', id: 'call_1' }] },
      { type: 'content', stopReason: 'tool_use' },
    ]);
  });

  it('reports a length stop as max_tokens', async () => {
    const fetch: FetchLike = async () => sse([delta({ content: 'cut' }, 'length'), '[DONE]']);
    const events = await collect(chat(fetch), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
    expect(events.at(-1)).toEqual({ type: 'content', stopReason: 'max_tokens' });
  });

  it('fails a reply that ends without finishing, naming the server', async () => {
    const fetch: FetchLike = async () => sse([delta({ content: 'half' })]);
    await expect(collect(chat(fetch), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /llama box ended the reply/
    );
  });

  it('asks for new credentials on 401', async () => {
    const fetch: FetchLike = async () => new Response('{"error":"unauthorized"}', { status: 401 });
    await expect(
      collect(chat(fetch), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toBeInstanceOf(ServerCredentialsError);
  });

  it('retries without tools when the server refuses them, and remembers', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.tools) return new Response('{"error":{"message":"tools param requires --jinja flag"}}', { status: 500 });
      return sse([delta({ content: 'ok' }, 'stop'), '[DONE]']);
    };
    const client = chat(fetch);
    const request = {
      model: MODEL,
      messages: [{ role: 'user' as const, content: 'hi' }],
      tools: [{ toolSchema: { name: 'read_file', parameters: { type: 'object' } } }],
    };
    await collect(client, request);
    await collect(client, request);
    expect(bodies.map(body => 'tools' in body)).toEqual([true, false, false]);
  });

  it('refuses a model id that belongs to another server', async () => {
    const fetch = vi.fn<FetchLike>();
    await expect(collect(chat(fetch), { model: 'local:srv-other:qwen', messages: [] })).rejects.toThrow(
      'Invalid local model id.'
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads llama-server's context size from /props", async () => {
    const fetch: FetchLike = async url =>
      String(url).endsWith('/props')
        ? new Response(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } }), { status: 200 })
        : new Response('{}', { status: 404 });
    expect(await chat(fetch).contextTokens(MODEL)).toBe(8192);
    expect(await chat(fetch, null).contextTokens(MODEL)).toBe(16384);
  });

  it('lists models keyed by its server id', async () => {
    const fetch: FetchLike = async () =>
      new Response(
        JSON.stringify({ object: 'list', data: [{ id: 'qwen2.5-0.5b', object: 'model', owned_by: 'llamacpp' }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    const [model] = await chat(fetch).listModels();
    expect(model).toMatchObject({ id: MODEL, name: 'qwen2.5-0.5b' });
  });
});

describe('toOpenAIMessages', () => {
  it('turns tool use and tool results into OpenAI tool calls and tool messages', () => {
    expect(
      toOpenAIMessages([
        { role: 'user', content: 'read a' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading.' },
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'A' }] }],
        },
      ])
    ).toEqual([
      { role: 'user', content: 'read a' },
      {
        role: 'assistant',
        content: 'Reading.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'A' },
    ]);
  });

  it('sends images as data URLs', () => {
    const [message] = toOpenAIMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        ],
      },
    ]);
    expect(message).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
      ],
    });
  });
});
