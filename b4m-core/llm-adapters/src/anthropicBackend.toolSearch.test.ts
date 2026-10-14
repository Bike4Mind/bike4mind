/**
 * Anthropic native tool search on the direct adapter: defer_loading and server tools in the request,
 * server_tool_use / tool_search_tool_result blocks surfaced as providerBlock frames and replayed
 * verbatim on the next turn whether or not thinking is on, and only tool_use blocks executed.
 */
import { describe, it, expect, vi } from 'vitest';
import { ChatModels, type IMessage } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import type { CompletionInfo, ICompletionOptionTools, ICompletionOptions } from './backend';

type Params = Record<string, unknown>;

function asyncIterable(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    controller: { abort: () => {} },
  };
}

/** Each create() call answers with the next scripted turn: an event list when streaming, a message otherwise. */
function buildBackend(turns: unknown[]) {
  const backend = new AnthropicBackend('test-key');
  const captured: Params[] = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (apiParams: Params) => {
        captured.push(structuredClone(apiParams));
        const turn = turns.shift();
        return Array.isArray(turn) ? asyncIterable(turn) : turn;
      },
    },
  };
  return { backend, captured };
}

function tool(
  name: string,
  extra: Partial<ICompletionOptionTools['toolSchema']> = {},
  toolFn = vi.fn(async () => 'ok')
) {
  return {
    toolSchema: {
      name,
      description: `The ${name} tool.`,
      parameters: { type: 'object' as const, properties: { city: { type: 'string', description: 'City' } } },
      ...extra,
    },
    toolFn,
  };
}

const messageStart = { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } };
const searchInput = { query: 'weather' };
const searchResult = {
  type: 'tool_search_tool_result',
  tool_use_id: 'srvtoolu_1',
  content: {
    type: 'tool_search_tool_search_result',
    tool_references: [{ type: 'tool_reference', tool_name: 'get_weather' }],
  },
};

function searchThenCallTurn(thinking: boolean, toolUses: Array<{ id: string; name: string }>): unknown[] {
  const events: unknown[] = [messageStart];
  if (thinking) {
    events.push(
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'search first' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 }
    );
  }
  const textIndex = thinking ? 1 : 0;
  events.push(
    { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: 'Let me ' } },
    { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: 'search.' } },
    { type: 'content_block_stop', index: textIndex }
  );
  const offset = textIndex + 1;
  events.push(
    {
      type: 'content_block_start',
      index: offset,
      content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: {} },
    },
    { type: 'content_block_delta', index: offset, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
    { type: 'content_block_delta', index: offset, delta: { type: 'input_json_delta', partial_json: '"weather"}' } },
    { type: 'content_block_stop', index: offset },
    { type: 'content_block_start', index: offset + 1, content_block: searchResult },
    { type: 'content_block_stop', index: offset + 1 }
  );
  toolUses.forEach((use, i) => {
    const index = offset + 2 + i;
    events.push(
      { type: 'content_block_start', index, content_block: { type: 'tool_use', ...use, input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"city":"Oslo"}' } },
      { type: 'content_block_stop', index }
    );
  });
  events.push(
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' }
  );
  return events;
}

const finalTurn = [
  messageStart,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sunny.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
];

function collect() {
  const infos: CompletionInfo[] = [];
  const cb = async (_text: (string | null | undefined)[], info?: CompletionInfo) => {
    if (info) infos.push(info);
  };
  return { infos, cb, providerBlocks: () => infos.filter(i => i.providerBlock).map(i => i.providerBlock) };
}

// CLAUDE_5_OPUS at `low` runs with thinking on; CLAUDE_5_SONNET at `none` switches it off.
const THINKING_MODES = [
  ['on', ChatModels.CLAUDE_5_OPUS, 'low'],
  ['off', ChatModels.CLAUDE_5_SONNET, 'none'],
] as const;

const searchTool = { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' } as const;

describe('AnthropicBackend.formatTools', () => {
  it('leaves plain tools byte-identical to the legacy shape', () => {
    const formatted = new AnthropicBackend('test-key').formatTools([tool('get_weather', { strict: true })]);
    expect(JSON.stringify(formatted)).toBe(
      JSON.stringify([
        {
          name: 'get_weather',
          description: 'The get_weather tool.',
          input_schema: { type: 'object', properties: { city: { type: 'string', description: 'City' } } },
        },
      ])
    );
  });

  it('passes defer_loading through and appends server tools verbatim with no input_schema', () => {
    const formatted = new AnthropicBackend('test-key').formatTools(
      [tool('get_weather', { defer_loading: true }), tool('ping')],
      [searchTool]
    );
    expect(formatted).toEqual([
      expect.objectContaining({ name: 'get_weather', defer_loading: true, input_schema: expect.any(Object) }),
      expect.not.objectContaining({ defer_loading: expect.anything() }),
      { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
    ]);
  });
});

describe('AnthropicBackend request body', () => {
  it('sends a plain-tool request exactly as before', async () => {
    const { backend, captured } = buildBackend([
      { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'hi' }],
      { stream: false, executeTools: false, tools: [tool('get_weather')] },
      async () => undefined
    );
    expect(JSON.stringify(captured[0].tools)).toBe(
      JSON.stringify([
        {
          name: 'get_weather',
          description: 'The get_weather tool.',
          input_schema: { type: 'object', properties: { city: { type: 'string', description: 'City' } } },
        },
      ])
    );
  });

  it('sends server tools even when no custom tool is offered', async () => {
    const { backend, captured } = buildBackend([
      { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'hi' }],
      { stream: false, executeTools: false, tools: [], providerTools: [searchTool] },
      async () => undefined
    );
    expect(captured[0].tools).toEqual([searchTool]);
  });

  it('passes tool_reference blocks inside a tool_result through untouched', async () => {
    const { backend, captured } = buildBackend([
      { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const toolResult = {
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: [{ type: 'tool_reference', tool_name: 'get_weather' }],
    };
    const messages = [
      { role: 'user', content: 'find a weather tool' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'find_tools', input: {} }] },
      { role: 'user', content: [toolResult] },
    ] as IMessage[];
    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      messages,
      { stream: false, executeTools: false, tools: [tool('find_tools'), tool('get_weather', { defer_loading: true })] },
      async () => undefined
    );
    const sent = captured[0].messages as Array<{ role: string; content: unknown }>;
    expect(sent.at(-1)?.content).toEqual([toolResult]);
  });
});

describe.each(THINKING_MODES)('AnthropicBackend tool search stream (thinking %s)', (mode, model, reasoningEffort) => {
  const thinking = mode === 'on';
  const options = (tools: ICompletionOptionTools[], extra: Partial<ICompletionOptions> = {}) => ({
    stream: true,
    reasoningEffort,
    tools,
    providerTools: [searchTool],
    ...extra,
  });

  it('surfaces server blocks as provider blocks and replays them in order before the tool_result', async () => {
    const getWeather = tool('get_weather', { defer_loading: true });
    const { backend, captured } = buildBackend([
      searchThenCallTurn(thinking, [{ id: 'toolu_1', name: 'get_weather' }]),
      finalTurn,
    ]);
    const { cb, providerBlocks } = collect();

    await backend.complete(model, [{ role: 'user', content: 'weather in Oslo?' }], options([getWeather]), cb);

    expect(providerBlocks()).toEqual([
      {
        provider: 'anthropic',
        block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: searchInput },
      },
      { provider: 'anthropic', block: searchResult },
    ]);
    expect(getWeather.toolFn).toHaveBeenCalledTimes(1);

    const replay = (captured[1].messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).slice(-2);
    expect(replay[0].role).toBe('assistant');
    expect(replay[0].content.map(b => b.type)).toEqual([
      ...(thinking ? ['thinking'] : []),
      'text',
      'server_tool_use',
      'tool_search_tool_result',
      'tool_use',
    ]);
    expect(replay[0].content).toContainEqual(expect.objectContaining({ type: 'server_tool_use', input: searchInput }));
    expect(replay[0].content).toContainEqual({ type: 'text', text: 'Let me search.' });
    expect(replay[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
    });
  });

  it('replays one assistant turn with every tool_result when the model calls tools in parallel', async () => {
    const getWeather = tool('get_weather', { defer_loading: true });
    const { backend, captured } = buildBackend([
      searchThenCallTurn(thinking, [
        { id: 'toolu_1', name: 'get_weather' },
        { id: 'toolu_2', name: 'get_weather' },
      ]),
      finalTurn,
    ]);

    await backend.complete(model, [{ role: 'user', content: 'weather?' }], options([getWeather]), collect().cb);

    const sent = captured[1].messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(sent.filter(m => m.content.some?.(b => b.type === 'server_tool_use'))).toHaveLength(1);
    expect(sent.at(-1)?.content.map(b => b.tool_use_id)).toEqual(['toolu_1', 'toolu_2']);
  });

  it('reports only the tool_use call to a caller that executes tools itself', async () => {
    const { backend } = buildBackend([searchThenCallTurn(thinking, [{ id: 'toolu_1', name: 'get_weather' }])]);
    const { infos, cb, providerBlocks } = collect();

    await backend.complete(
      model,
      [{ role: 'user', content: 'weather?' }],
      options([tool('get_weather', { defer_loading: true })], { executeTools: false }),
      cb
    );

    expect(providerBlocks()).toHaveLength(2);
    expect(infos.at(-1)?.toolsUsed?.map(t => t.id)).toEqual(['toolu_1']);
  });
});

describe('AnthropicBackend tool search replay', () => {
  it('keeps redacted_thinking and drops an empty text block in the replayed turn', async () => {
    const turn = [
      messageStart,
      { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_stop', index: 1 },
      ...(searchThenCallTurn(false, [{ id: 'toolu_1', name: 'get_weather' }]) as Array<{ index?: number }>)
        .slice(1)
        .map(e => (e.index === undefined ? e : { ...e, index: e.index + 2 })),
    ];
    const { backend, captured } = buildBackend([turn, finalTurn]);

    await backend.complete(
      ChatModels.CLAUDE_5_OPUS,
      [{ role: 'user', content: 'weather?' }],
      { stream: true, reasoningEffort: 'low', tools: [tool('get_weather')], providerTools: [searchTool] },
      collect().cb
    );

    const replay = (captured[1].messages as Array<{ content: Array<Record<string, unknown>> }>).at(-2);
    expect(replay?.content.map(b => b.type)).toEqual([
      'redacted_thinking',
      'text',
      'server_tool_use',
      'tool_search_tool_result',
      'tool_use',
    ]);
    expect(replay?.content[0]).toEqual({ type: 'redacted_thinking', data: 'opaque' });
  });
});

describe('AnthropicBackend tool search (non-streaming)', () => {
  it('emits text and provider blocks in response order', async () => {
    const serverToolUse = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: {} };
    const { backend } = buildBackend([
      {
        content: [
          { type: 'text', text: 'Searching.' },
          serverToolUse,
          searchResult,
          { type: 'text', text: 'Found it.' },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    const frames: string[] = [];
    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'weather?' }],
      { stream: false, executeTools: false, tools: [tool('get_weather')], providerTools: [searchTool] },
      async (text, info) => {
        if (info?.providerBlock) frames.push(String(info.providerBlock.block.type));
        else if (text.join('')) frames.push(text.join(''));
      }
    );

    expect(frames).toEqual(['Searching.', 'server_tool_use', 'tool_search_tool_result', 'Found it.']);
  });

  it('surfaces server blocks from the response as provider blocks', async () => {
    const serverToolUse = {
      type: 'server_tool_use',
      id: 'srvtoolu_1',
      name: 'tool_search_tool_regex',
      input: searchInput,
    };
    const { backend } = buildBackend([
      {
        content: [serverToolUse, searchResult, { type: 'text', text: 'No weather tool found.' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    const { cb, providerBlocks } = collect();

    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'weather?' }],
      {
        stream: false,
        executeTools: false,
        tools: [tool('get_weather', { defer_loading: true })],
        providerTools: [searchTool],
      },
      cb
    );

    expect(providerBlocks()).toEqual([
      { provider: 'anthropic', block: serverToolUse },
      { provider: 'anthropic', block: searchResult },
    ]);
  });
});
