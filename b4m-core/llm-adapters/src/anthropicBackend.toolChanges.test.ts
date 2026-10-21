/**
 * Mid-conversation tool changes on the direct Anthropic adapter: tool_addition / tool_removal system
 * messages stay between turns instead of being hoisted into `system`, and their beta is merged with
 * prompt caching's into one header.
 */
import { describe, it, expect } from 'vitest';
import { ChatModels, type IMessage } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';

type Params = Record<string, unknown>;
type Call = { params: Params; headers?: Record<string, string> };

function buildBackend() {
  const backend = new AnthropicBackend('test-key');
  const calls: Call[] = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (params: Params, requestOptions?: { headers?: Record<string, string> }) => {
        calls.push({ params: structuredClone(params), headers: requestOptions?.headers });
        return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  return { backend, calls };
}

const getWeather = {
  toolSchema: {
    name: 'get_weather',
    description: 'The get_weather tool.',
    parameters: { type: 'object' as const, properties: {} },
    defer_loading: true,
  },
  toolFn: async () => 'ok',
};
const ping = { ...getWeather, toolSchema: { ...getWeather.toolSchema, name: 'ping', defer_loading: undefined } };

const addition = {
  role: 'system',
  content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'get_weather' } }],
} as IMessage;

async function send(messages: IMessage[]) {
  const { backend, calls } = buildBackend();
  await backend.complete(
    ChatModels.CLAUDE_5_5_OPUS,
    messages,
    { stream: false, executeTools: false, tools: [ping, getWeather] },
    async () => undefined
  );
  return calls[0];
}

describe('AnthropicBackend mid-conversation tool changes', () => {
  const conversation = [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'weather?' },
    addition,
  ] as IMessage[];

  it('keeps the change in place with the system role and leaves it out of the system prompt', async () => {
    const { params } = await send(conversation);
    const sent = params.messages as Array<{ role: string; content: unknown }>;
    expect(sent.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'system']);
    expect(sent[3]).toEqual({ role: 'system', content: addition.content });
    expect(JSON.stringify(params.system)).toContain('be brief');
    expect(JSON.stringify(params.system)).not.toContain('tool_addition');
  });

  it('keeps the change out of a cache-flagged system block list too', async () => {
    const { params } = await send([
      { role: 'system', content: 'be brief', cache: true },
      ...conversation.slice(1),
    ] as IMessage[]);
    const system = params.system as Array<{ text: string }>;
    expect(system[0]).toMatchObject({
      text: expect.stringContaining('be brief'),
      cache_control: { type: 'ephemeral' },
    });
    expect(JSON.stringify(system)).not.toContain('tool_addition');
    expect((params.messages as Array<{ role: string }>).at(-1)?.role).toBe('system');
  });

  it('keeps a change followed by an assistant turn between the user and assistant messages', async () => {
    const { params } = await send([
      { role: 'user', content: 'hi' },
      addition,
      { role: 'assistant', content: 'loaded' },
      { role: 'user', content: 'thanks' },
    ] as IMessage[]);
    expect((params.messages as Array<{ role: string }>).map(m => m.role)).toEqual([
      'user',
      'system',
      'assistant',
      'user',
    ]);
  });

  it('sends only the tool changes beta when nothing is cache-flagged', async () => {
    const { headers } = await send(conversation);
    expect(headers).toEqual({ 'anthropic-beta': 'mid-conversation-tool-changes-2026-07-01' });
  });

  it('merges the tool changes beta with the prompt caching beta', async () => {
    const { headers } = await send([
      ...conversation.slice(0, 3),
      { role: 'user', content: 'weather?', cache: true },
      addition,
    ] as IMessage[]);
    expect(headers).toEqual({
      'anthropic-beta': 'prompt-caching-2024-07-31,mid-conversation-tool-changes-2026-07-01',
    });
  });

  it('sends no tool changes beta, and no system-role message, without a change', async () => {
    const { params, headers } = await send(conversation.slice(0, 4));
    expect(headers).toBeUndefined();
    expect((params.messages as Array<{ role: string }>).some(m => m.role === 'system')).toBe(false);
  });

  it('keeps the prompt caching header as it was without a change', async () => {
    const { headers } = await send([
      { role: 'user', content: 'hi', cache: true },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ] as IMessage[]);
    expect(headers).toEqual({ 'anthropic-beta': 'prompt-caching-2024-07-31' });
  });
});
