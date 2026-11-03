/**
 * Anthropic tool search on the Bedrock Claude adapter: defer_loading and server tools reach the
 * InvokeModel body, server blocks are surfaced as provider blocks and replayed in order, and the
 * usage a tool search adds mid-response is reported. Event shapes follow a live Bedrock stream.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildCompletionStreamEvent,
  ChatModels,
  type IMessage,
  type ProviderBlock,
  type ToolSearchServerTool,
} from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';
import type { CompletionInfo, ICompletionOptions, ICompletionOptionTools } from '../backend';

const MODEL = ChatModels.CLAUDE_5_5_SONNET_BEDROCK;

class RecordingBedrockBackend extends AnthropicBedrockBackend {
  sentBodies: string[] = [];

  constructor(
    private readonly streamRounds: unknown[][] = [],
    private readonly jsonRounds: unknown[] = []
  ) {
    super();
  }

  protected override updateClientForModel(_model: string): void {
    // no real client
  }

  protected override async invokeModelStream(input: {
    modelId: string;
    contentType: string;
    accept: string;
    body: string;
  }): Promise<{ body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> }> {
    const round = this.streamRounds[this.sentBodies.length] ?? [];
    this.sentBodies.push(input.body);
    return {
      body: {
        [Symbol.asyncIterator]: async function* () {
          for (const chunk of round) yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(chunk)) } };
        },
      },
    };
  }

  protected override async invokeModel(input: {
    modelId: string;
    contentType: string;
    accept: string;
    body: string;
  }): Promise<{ body?: Uint8Array }> {
    const round = this.jsonRounds[this.sentBodies.length];
    this.sentBodies.push(input.body);
    if (!round) throw new Error(`no canned non-streaming round ${this.sentBodies.length - 1}`);
    return { body: new TextEncoder().encode(JSON.stringify(round)) };
  }

  body(i: number): { tools?: unknown[]; messages: Array<{ role: string; content: unknown }> } {
    return JSON.parse(this.sentBodies[i]);
  }
}

const REGEX_TOOL: ToolSearchServerTool = { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' };
const SERVER_ID = 'srvtoolu_bdrk_01PfCqTek6BXGXaoEeSnetxZ';
const SIGNATURE = 'EqQBCkYIBRgCsignature';

function tool(name: string, extra: Record<string, unknown> = {}, result = `${name} result`): ICompletionOptionTools {
  return {
    toolFn: async () => result,
    toolSchema: {
      name,
      description: `The ${name} tool`,
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
      ...extra,
    },
  } as ICompletionOptionTools;
}

const serverToolUseEvents = (index: number) => [
  {
    type: 'content_block_start',
    index,
    content_block: { type: 'server_tool_use', id: SERVER_ID, name: 'tool_search_tool_regex', input: {} },
  },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '' } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"pattern"' } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: ': "weather"}' } },
  { type: 'content_block_stop', index },
];

const SEARCH_RESULT = {
  type: 'tool_search_tool_result',
  tool_use_id: SERVER_ID,
  content: {
    type: 'tool_search_tool_search_result',
    tool_references: [{ type: 'tool_reference', tool_name: 'get_weather' }],
  },
};

const searchResultEvents = (index: number) => [
  { type: 'content_block_start', index, content_block: SEARCH_RESULT },
  { type: 'content_block_stop', index },
];

const textEvents = (index: number, text: string) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index },
];

const toolUseEvents = (index: number, id: string, name: string, input: string) => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: input } },
  { type: 'content_block_stop', index },
];

const thinkingEvents = (index: number) => [
  { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'Search for a weather tool.' } },
  { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: SIGNATURE } },
  { type: 'content_block_stop', index },
];

function round(blocks: unknown[], stopReason = 'tool_use', usage = { start: 716, end: 1629 }): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: usage.start, output_tokens: 24 } } },
    ...blocks,
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason },
      usage: { input_tokens: usage.end, output_tokens: 114 },
    },
    { type: 'message_stop' },
  ];
}

const answerRound = () => round(textEvents(0, 'It is sunny in Paris.'), 'end_turn', { start: 1700, end: 1700 });

const searchThenToolRound = () =>
  round([
    ...textEvents(0, 'Let me search.'),
    ...serverToolUseEvents(1),
    ...searchResultEvents(2),
    ...toolUseEvents(3, 'toolu_weather', 'get_weather', '{"city":"Paris"}'),
  ]);

type Frame = { text: string } | { block: ProviderBlock['block'] };

async function run(
  backend: RecordingBedrockBackend,
  options: Partial<ICompletionOptions>,
  messages: IMessage[] = [{ role: 'user', content: 'What is the weather in Paris?' }]
) {
  const frames: Frame[] = [];
  const infos: CompletionInfo[] = [];
  await backend.complete(MODEL, messages, { maxTokens: 1024, stream: true, ...options }, async (text, info) => {
    if (info) infos.push(info);
    if (info?.providerBlock) frames.push({ block: info.providerBlock.block });
    const joined = text.filter((t): t is string => typeof t === 'string').join('');
    if (joined) frames.push({ text: joined });
  });
  return { frames, infos, last: infos[infos.length - 1] };
}

describe('AnthropicBedrockBackend.formatTools', () => {
  const backend = new AnthropicBedrockBackend();

  it('leaves plain tools byte-identical to the legacy shape', () => {
    const plain = [tool('b_tool', { strict: true }), tool('a_tool')];
    expect(JSON.stringify(backend.formatTools(plain))).toBe(
      JSON.stringify([
        {
          name: 'a_tool',
          description: 'The a_tool tool',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
        {
          name: 'b_tool',
          description: 'The b_tool tool',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ])
    );
  });

  it('passes defer_loading through and appends server tools verbatim with no input_schema', () => {
    const formatted = backend.formatTools(
      [tool('get_time'), tool('get_weather', { defer_loading: true })],
      [REGEX_TOOL]
    );
    expect(formatted).toEqual([
      expect.objectContaining({ name: 'get_time', input_schema: expect.any(Object) }),
      expect.objectContaining({ name: 'get_weather', defer_loading: true, input_schema: expect.any(Object) }),
      { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
    ]);
    expect(formatted[0]).not.toHaveProperty('defer_loading');
  });
});

describe('AnthropicBedrockBackend tool search request body', () => {
  it('sends server tools even when no custom tool is offered', async () => {
    const backend = new RecordingBedrockBackend([answerRound()]);
    await run(backend, { tools: [], providerTools: [REGEX_TOOL] });
    expect(backend.body(0).tools).toEqual([REGEX_TOOL]);
  });

  it('keeps cache_control off deferred and server tools when caching marks the tools', async () => {
    const backend = new RecordingBedrockBackend([answerRound()]);
    await run(backend, {
      tools: [tool('a_eager'), tool('z_deferred', { defer_loading: true })],
      providerTools: [REGEX_TOOL],
      cacheStrategy: {
        enableCaching: true,
        cacheTools: true,
        cacheSystemPrompt: false,
        cacheConversationHistory: false,
      },
    } as Partial<ICompletionOptions>);
    const tools = backend.body(0).tools as Array<Record<string, unknown>>;
    expect(tools[0]).toHaveProperty('cache_control');
    expect(tools[1]).not.toHaveProperty('cache_control');
    expect(tools[2]).not.toHaveProperty('cache_control');
  });

  it('passes echoed server blocks and tool_reference blocks inside a tool_result through untouched', async () => {
    const backend = new RecordingBedrockBackend([answerRound()]);
    const references = [{ type: 'tool_reference', tool_name: 'get_weather' }];
    const echoedTurn = [
      { type: 'server_tool_use', id: SERVER_ID, name: 'tool_search_tool_regex', input: { pattern: 'weather' } },
      SEARCH_RESULT,
      { type: 'tool_use', id: 'toolu_search', name: 'client_search', input: { q: 'weather' } },
    ];
    await run(
      backend,
      { tools: [tool('client_search'), tool('get_weather', { defer_loading: true })], providerTools: [REGEX_TOOL] },
      [
        { role: 'user', content: 'What is the weather in Paris?' },
        { role: 'assistant', content: echoedTurn } as IMessage,
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_search', content: references }],
        } as IMessage,
      ]
    );
    const { messages } = backend.body(0);
    expect(messages[1].content).toEqual(echoedTurn);
    expect(messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_search', content: references }]);
  });

  it('strips echoed server blocks from a history when no tools are offered', async () => {
    const backend = new RecordingBedrockBackend([answerRound()]);
    await run(backend, { tools: [] }, [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: [SEARCH_RESULT, { type: 'text', text: 'Done.' }] } as IMessage,
      { role: 'user', content: 'Thanks' },
    ]);
    const blocks = backend.body(0).messages.flatMap(m => (Array.isArray(m.content) ? m.content : []));
    expect(blocks.some(b => (b as { type?: string }).type === 'tool_search_tool_result')).toBe(false);
  });
});

describe('AnthropicBedrockBackend tool search stream', () => {
  it('delivers prose after a client tool call without adding it to the arguments', async () => {
    const backend = new RecordingBedrockBackend([
      round([
        ...serverToolUseEvents(0),
        ...searchResultEvents(1),
        ...toolUseEvents(2, 'toolu_weather', 'get_weather', '{"city":"Paris"}'),
        ...textEvents(3, 'Checking the forecast now.'),
      ]),
    ]);
    const { frames, last } = await run(backend, {
      tools: [tool('get_weather', { defer_loading: true })],
      providerTools: [REGEX_TOOL],
      executeTools: false,
    });

    expect(frames).toEqual([
      { block: expect.objectContaining({ type: 'server_tool_use' }) },
      { block: SEARCH_RESULT },
      { text: 'Checking the forecast now.' },
    ]);
    expect(last?.toolsUsed).toEqual([{ name: 'get_weather', arguments: '{"city":"Paris"}', id: 'toolu_weather' }]);
  });

  it('surfaces server blocks as provider blocks in order and reports only the tool_use (thinking off)', async () => {
    const backend = new RecordingBedrockBackend([searchThenToolRound()]);
    const { frames, last } = await run(backend, {
      tools: [tool('get_time'), tool('get_weather', { defer_loading: true })],
      providerTools: [REGEX_TOOL],
      executeTools: false,
    });

    expect(frames).toEqual([
      { text: 'Let me search.' },
      {
        block: {
          type: 'server_tool_use',
          id: SERVER_ID,
          name: 'tool_search_tool_regex',
          input: { pattern: 'weather' },
        },
      },
      { block: SEARCH_RESULT },
    ]);
    expect(last?.toolsUsed).toEqual([{ name: 'get_weather', arguments: '{"city":"Paris"}', id: 'toolu_weather' }]);
  });

  it('surfaces server blocks with thinking on and keeps the input JSON out of the text', async () => {
    const backend = new RecordingBedrockBackend([
      round([
        ...thinkingEvents(0),
        ...serverToolUseEvents(1),
        ...searchResultEvents(2),
        ...toolUseEvents(3, 'toolu_weather', 'get_weather', '{"city":"Paris"}'),
      ]),
    ]);
    const { frames } = await run(backend, {
      tools: [tool('get_time'), tool('get_weather', { defer_loading: true })],
      providerTools: [REGEX_TOOL],
      executeTools: false,
      thinking: { enabled: true, budget_tokens: 2048 },
    });

    const blocks = frames.filter((f): f is { block: Record<string, unknown> } => 'block' in f).map(f => f.block.type);
    expect(blocks).toEqual(['server_tool_use', 'tool_search_tool_result']);
    expect(frames.some(f => 'text' in f && f.text.includes('pattern'))).toBe(false);
  });

  it('replays the turn in order before the tool_result on an executeTools round (thinking on)', async () => {
    const backend = new RecordingBedrockBackend([
      round([
        ...thinkingEvents(0),
        ...serverToolUseEvents(1),
        ...searchResultEvents(2),
        ...textEvents(3, 'Found it.'),
        ...toolUseEvents(4, 'toolu_weather', 'get_weather', '{"city":"Paris"}'),
      ]),
      answerRound(),
    ]);
    await run(backend, {
      tools: [tool('get_time'), tool('get_weather', { defer_loading: true })],
      providerTools: [REGEX_TOOL],
      thinking: { enabled: true, budget_tokens: 2048 },
    });

    const { messages } = backend.body(1);
    expect(messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Search for a weather tool.', signature: SIGNATURE },
          { type: 'server_tool_use', id: SERVER_ID, name: 'tool_search_tool_regex', input: { pattern: 'weather' } },
          SEARCH_RESULT,
          { type: 'text', text: 'Found it.' },
          { type: 'tool_use', id: 'toolu_weather', name: 'get_weather', input: { city: 'Paris' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_weather', content: 'get_weather result' }] },
    ]);
  });

  it('replays the turn with thinking off, dropping an empty text block', async () => {
    const backend = new RecordingBedrockBackend([
      round([
        ...textEvents(0, ''),
        ...serverToolUseEvents(1),
        ...searchResultEvents(2),
        ...toolUseEvents(3, 'toolu_weather', 'get_weather', '{"city":"Paris"}'),
      ]),
      answerRound(),
    ]);
    await run(backend, { tools: [tool('get_weather', { defer_loading: true })], providerTools: [REGEX_TOOL] });

    const assistant = backend.body(1).messages[1].content as Array<{ type: string }>;
    expect(assistant.map(b => b.type)).toEqual(['server_tool_use', 'tool_search_tool_result', 'tool_use']);
  });

  it('merges parallel tool calls into one assistant turn and one tool_result message', async () => {
    const backend = new RecordingBedrockBackend([
      round([
        ...serverToolUseEvents(0),
        ...searchResultEvents(1),
        ...toolUseEvents(2, 'toolu_weather', 'get_weather', '{"city":"Paris"}'),
        ...toolUseEvents(3, 'toolu_time', 'get_time', '{"city":"Paris"}'),
      ]),
      answerRound(),
    ]);
    await run(backend, {
      tools: [tool('get_time'), tool('get_weather', { defer_loading: true })],
      providerTools: [REGEX_TOOL],
    });

    const { messages } = backend.body(1);
    expect(messages).toHaveLength(3);
    expect((messages[1].content as Array<{ type: string; id?: string }>).map(b => b.id ?? b.type)).toEqual([
      SERVER_ID,
      'tool_search_tool_result',
      'toolu_weather',
      'toolu_time',
    ]);
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_weather', content: 'get_weather result' },
      { type: 'tool_result', tool_use_id: 'toolu_time', content: 'get_time result' },
    ]);
  });

  it('leaves out of the replay a parallel call that never ran', async () => {
    const backend = new RecordingBedrockBackend([
      round([
        ...serverToolUseEvents(0),
        ...searchResultEvents(1),
        ...toolUseEvents(2, 'toolu_weather', 'get_weather', '{"city":"Paris"}'),
        ...toolUseEvents(3, 'toolu_ghost', 'not_offered', '{}'),
      ]),
      answerRound(),
    ]);
    await run(backend, { tools: [tool('get_weather', { defer_loading: true })], providerTools: [REGEX_TOOL] });

    const assistant = backend.body(1).messages[1].content as Array<{ type: string; id?: string }>;
    expect(assistant.filter(b => b.type === 'tool_use').map(b => b.id)).toEqual(['toolu_weather']);
  });

  it('replays each round before its own tool_result across two sequential tool rounds', async () => {
    const backend = new RecordingBedrockBackend([
      searchThenToolRound(),
      round(toolUseEvents(0, 'toolu_time', 'get_time', '{}'), 'tool_use', { start: 1800, end: 1800 }),
      answerRound(),
    ]);
    await run(backend, {
      tools: [tool('get_time'), tool('get_weather', { defer_loading: true })],
      providerTools: [REGEX_TOOL],
    });

    const roles = backend.body(2).messages.map(m => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(backend.body(2).messages[3].content).toEqual([
      { type: 'tool_use', id: 'toolu_time', name: 'get_time', input: {} },
    ]);
  });

  it('replays a second provider-block round as its own turn, not as a sibling of the first', async () => {
    const secondSearchRound = round(
      [
        ...serverToolUseEvents(0),
        ...searchResultEvents(1),
        ...toolUseEvents(2, 'toolu_time', 'get_time', '{"city":"Paris"}'),
      ],
      'tool_use',
      { start: 1800, end: 1800 }
    );
    const backend = new RecordingBedrockBackend([searchThenToolRound(), secondSearchRound, answerRound()]);
    await run(backend, {
      tools: [tool('get_time', { defer_loading: true }), tool('get_weather', { defer_loading: true })],
      providerTools: [REGEX_TOOL],
    });

    const messages = backend.body(2).messages;
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    const toolUseIds = (i: number) =>
      (messages[i].content as Array<{ type: string; id?: string }>).filter(b => b.type === 'tool_use').map(b => b.id);
    expect(toolUseIds(1)).toEqual(['toolu_weather']);
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_weather', content: 'get_weather result' },
    ]);
    expect(toolUseIds(3)).toEqual(['toolu_time']);
    expect(messages[4].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_time', content: 'get_time result' },
    ]);
  });

  it('replays a redacted_thinking block in place on a provider-block turn', async () => {
    const backend = new RecordingBedrockBackend([
      round([
        { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque' } },
        { type: 'content_block_stop', index: 0 },
        ...serverToolUseEvents(1),
        ...searchResultEvents(2),
        ...toolUseEvents(3, 'toolu_weather', 'get_weather', '{"city":"Paris"}'),
      ]),
      answerRound(),
    ]);
    await run(backend, { tools: [tool('get_weather', { defer_loading: true })], providerTools: [REGEX_TOOL] });

    const assistant = backend.body(1).messages[1].content as Array<{ type: string }>;
    expect(assistant[0]).toEqual({ type: 'redacted_thinking', data: 'opaque' });
    expect(assistant.map(b => b.type)).toEqual([
      'redacted_thinking',
      'server_tool_use',
      'tool_search_tool_result',
      'tool_use',
    ]);
  });

  it('gives a server_tool_use that streamed no input an empty input', async () => {
    const backend = new RecordingBedrockBackend([
      round(
        [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'server_tool_use', id: SERVER_ID, name: 'tool_search_tool_regex' },
          },
          { type: 'content_block_stop', index: 0 },
          ...searchResultEvents(1),
        ],
        'pause_turn'
      ),
    ]);
    const { frames } = await run(backend, {
      tools: [tool('get_time')],
      providerTools: [REGEX_TOOL],
      executeTools: false,
    });
    expect(frames[0]).toEqual({
      block: { type: 'server_tool_use', id: SERVER_ID, name: 'tool_search_tool_regex', input: {} },
    });
  });

  it('emits the server block with an empty input when its input JSON is malformed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = serverToolUseEvents(0);
    events.splice(1, 3, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"pat' },
    });
    const backend = new RecordingBedrockBackend([
      round([...events, ...searchResultEvents(1), ...textEvents(2, 'None.')], 'end_turn'),
    ]);
    const { frames } = await run(backend, { tools: [tool('get_time')], providerTools: [REGEX_TOOL] });

    expect(frames[0]).toEqual({ block: expect.objectContaining({ type: 'server_tool_use', input: {} }) });
    expect(warn).toHaveBeenCalledWith(
      '[AnthropicBedrockBackend] Malformed server tool input JSON at content_block_stop',
      expect.any(Object)
    );
    warn.mockRestore();
  });

  it('ends a paused turn of only provider blocks with pause_turn instead of the empty-response error', async () => {
    const backend = new RecordingBedrockBackend([
      round([...serverToolUseEvents(0), ...searchResultEvents(1)], 'pause_turn'),
    ]);
    const { frames, last } = await run(backend, {
      tools: [tool('get_time')],
      providerTools: [REGEX_TOOL],
      executeTools: false,
    });

    expect(frames).toHaveLength(2);
    expect(last?.stopReason).toBe('pause_turn');
  });
});

describe('AnthropicBedrockBackend usage on a tool search turn', () => {
  it('retains larger initial usage when the final event reports lower counts', async () => {
    const backend = new RecordingBedrockBackend([
      [
        {
          type: 'message_start',
          message: { usage: { input_tokens: 1629, cache_read_input_tokens: 1800, cache_creation_input_tokens: 40 } },
        },
        ...serverToolUseEvents(0),
        ...searchResultEvents(1),
        {
          type: 'message_delta',
          delta: { stop_reason: 'pause_turn' },
          usage: {
            input_tokens: 716,
            output_tokens: 114,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 0,
          },
        },
        { type: 'message_stop' },
      ],
    ]);
    const { last } = await run(backend, { providerTools: [REGEX_TOOL], executeTools: false });

    expect(last).toMatchObject({
      inputTokens: 1629,
      outputTokens: 114,
      cacheReadInputTokens: 1800,
      cacheCreationInputTokens: 40,
    });
    expect(last?.turnUsage).toEqual([
      { inputTokens: 1629, outputTokens: 114, cacheReadInputTokens: 1800, cacheCreationInputTokens: 40 },
    ]);
  });

  it('reports the message_delta input and cache tokens, which include the loaded definitions', async () => {
    const events = searchThenToolRound();
    events[0] = {
      type: 'message_start',
      message: {
        usage: { input_tokens: 716, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
      },
    };
    events[events.length - 2] = {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { input_tokens: 1629, output_tokens: 114, cache_read_input_tokens: 1800, cache_creation_input_tokens: 40 },
    };
    const backend = new RecordingBedrockBackend([events]);
    const { last } = await run(backend, {
      tools: [tool('get_time'), tool('get_weather', { defer_loading: true })],
      providerTools: [REGEX_TOOL],
      executeTools: false,
    });

    expect(last).toMatchObject({
      inputTokens: 1629,
      outputTokens: 114,
      cacheReadInputTokens: 1800,
      cacheCreationInputTokens: 40,
    });
    expect(last?.turnUsage).toEqual([
      { inputTokens: 1629, outputTokens: 114, cacheReadInputTokens: 1800, cacheCreationInputTokens: 40 },
    ]);
  });

  it('keeps reporting message_start usage when message_delta carries only output tokens', async () => {
    const backend = new RecordingBedrockBackend([
      [
        { type: 'message_start', message: { usage: { input_tokens: 500, cache_read_input_tokens: 300 } } },
        ...textEvents(0, 'Hi.'),
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ],
    ]);
    const { last } = await run(backend, { tools: [] });
    expect(last).toMatchObject({ inputTokens: 500, outputTokens: 5, cacheReadInputTokens: 300 });
    expect(last?.stopReason).toBe('end_turn');
  });
});

describe('AnthropicBedrockBackend tool search (non-streaming)', () => {
  const response = (content: unknown[], stopReason = 'tool_use') => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content,
    stop_reason: stopReason,
    usage: { input_tokens: 1631, output_tokens: 107, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 },
  });
  const serverToolUse = {
    type: 'server_tool_use',
    id: SERVER_ID,
    name: 'tool_search_tool_regex',
    input: { pattern: 'weather' },
  };

  it('reports every parallel tool call while emitting the surrounding text once in order', async () => {
    const backend = new RecordingBedrockBackend(
      [],
      [
        response([
          { type: 'text', text: 'Searching.' },
          serverToolUse,
          SEARCH_RESULT,
          { type: 'tool_use', id: 'toolu_weather', name: 'get_weather', input: { city: 'Paris' } },
          { type: 'text', text: 'Checking both.' },
          { type: 'tool_use', id: 'toolu_time', name: 'get_time', input: { city: 'Paris' } },
        ]),
      ]
    );
    const { frames, last } = await run(backend, {
      stream: false,
      tools: [tool('get_weather', { defer_loading: true }), tool('get_time')],
      providerTools: [REGEX_TOOL],
      executeTools: false,
    });

    expect(frames).toEqual([
      { text: 'Searching.' },
      { block: serverToolUse },
      { block: SEARCH_RESULT },
      { text: 'Checking both.' },
    ]);
    expect(last?.toolsUsed).toEqual([
      { name: 'get_weather', arguments: '{"city":"Paris"}', id: 'toolu_weather' },
      { name: 'get_time', arguments: '{"city":"Paris"}', id: 'toolu_time' },
    ]);
    expect(last).toMatchObject({ inputTokens: 1631, outputTokens: 107, cacheReadInputTokens: 600 });
  });

  it('executes and replays every parallel tool call in one provider turn', async () => {
    const weather = tool('get_weather', { defer_loading: true });
    const time = tool('get_time');
    const weatherCall = vi.spyOn(weather, 'toolFn');
    const timeCall = vi.spyOn(time, 'toolFn');
    const content = [
      serverToolUse,
      SEARCH_RESULT,
      { type: 'tool_use', id: 'toolu_weather', name: 'get_weather', input: { city: 'Paris' } },
      { type: 'tool_use', id: 'toolu_time', name: 'get_time', input: { city: 'Paris' } },
    ];
    const backend = new RecordingBedrockBackend(
      [],
      [response(content), response([{ type: 'text', text: 'Sunny.' }], 'end_turn')]
    );
    const { last } = await run(backend, {
      stream: false,
      tools: [weather, time],
      providerTools: [REGEX_TOOL],
    });

    expect(weatherCall).toHaveBeenCalledExactlyOnceWith({ city: 'Paris' });
    expect(timeCall).toHaveBeenCalledExactlyOnceWith({ city: 'Paris' });
    expect(backend.body(1).messages.slice(1)).toEqual([
      { role: 'assistant', content },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_weather', content: 'get_weather result' },
          { type: 'tool_result', tool_use_id: 'toolu_time', content: 'get_time result' },
        ],
      },
    ]);
    expect(last).toMatchObject({ inputTokens: 3262, outputTokens: 214, cacheReadInputTokens: 1200 });
    expect(last?.turnUsage).toHaveLength(2);
  });

  it('emits text and provider blocks in response order with the usage', async () => {
    const backend = new RecordingBedrockBackend(
      [],
      [
        response([
          { type: 'text', text: 'Let me search.' },
          serverToolUse,
          SEARCH_RESULT,
          { type: 'text', text: 'Found it.' },
          { type: 'tool_use', id: 'toolu_weather', name: 'get_weather', input: { city: 'Paris' } },
        ]),
      ]
    );
    const { frames, last } = await run(backend, {
      stream: false,
      tools: [tool('get_weather', { defer_loading: true })],
      providerTools: [REGEX_TOOL],
      executeTools: false,
    });

    expect(frames).toEqual([
      { text: 'Let me search.' },
      { block: serverToolUse },
      { block: SEARCH_RESULT },
      { text: 'Found it.' },
    ]);
    expect(last).toMatchObject({ inputTokens: 1631, outputTokens: 107, cacheReadInputTokens: 600 });
  });

  it('replays server blocks on an executeTools turn', async () => {
    const backend = new RecordingBedrockBackend(
      [],
      [
        response([
          serverToolUse,
          SEARCH_RESULT,
          { type: 'tool_use', id: 'toolu_weather', name: 'get_weather', input: { city: 'Paris' } },
        ]),
        response([{ type: 'text', text: 'Sunny.' }], 'end_turn'),
      ]
    );
    await run(backend, {
      stream: false,
      tools: [tool('get_weather', { defer_loading: true })],
      providerTools: [REGEX_TOOL],
    });

    expect(backend.body(1).messages[1].content).toEqual([
      serverToolUse,
      SEARCH_RESULT,
      { type: 'tool_use', id: 'toolu_weather', name: 'get_weather', input: { city: 'Paris' } },
    ]);
  });

  it('reports pause_turn on a response of only provider blocks', async () => {
    const backend = new RecordingBedrockBackend([], [response([serverToolUse, SEARCH_RESULT], 'pause_turn')]);
    const { frames, last } = await run(backend, {
      stream: false,
      tools: [tool('get_time')],
      providerTools: [REGEX_TOOL],
      executeTools: false,
    });
    expect(frames).toEqual([{ block: serverToolUse }, { block: SEARCH_RESULT }]);
    expect(last?.stopReason).toBe('pause_turn');
  });
});

describe('AnthropicBedrockBackend wire frames on an executeTools:false turn', () => {
  // Built at callback time, as the completions API does, since toolsUsed is shared and mutated.
  async function wireFrames(backend: RecordingBedrockBackend, options: Partial<ICompletionOptions>) {
    const frames: Array<{ type: string; text?: string; tools?: string[] }> = [];
    await backend.complete(
      MODEL,
      [{ role: 'user', content: 'What is the weather in Paris?' }],
      { maxTokens: 1024, executeTools: false, ...options },
      async (text, info) => {
        const event = buildCompletionStreamEvent(text, info);
        frames.push(
          event.type === 'provider_block'
            ? { type: event.type }
            : { type: event.type, text: event.text, ...(event.tools ? { tools: event.tools.map(t => t.id!) } : {}) }
        );
      }
    );
    return frames;
  }
  const toolUseFrames = (frames: Awaited<ReturnType<typeof wireFrames>>) => frames.filter(f => f.type === 'tool_use');
  const response = (content: unknown[]) => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content,
    stop_reason: 'tool_use',
    usage: { input_tokens: 1631, output_tokens: 107 },
  });
  const serverToolUse = {
    type: 'server_tool_use',
    id: SERVER_ID,
    name: 'tool_search_tool_regex',
    input: { pattern: 'weather' },
  };
  const weatherCall = { type: 'tool_use', id: 'toolu_weather', name: 'get_weather', input: { city: 'Paris' } };
  const timeCall = { type: 'tool_use', id: 'toolu_time', name: 'get_time', input: { city: 'Paris' } };

  it('emits one tool_use frame, after the provider blocks, on a non-streaming tool search turn', async () => {
    const backend = new RecordingBedrockBackend([], [response([serverToolUse, SEARCH_RESULT, weatherCall])]);
    const frames = await wireFrames(backend, {
      stream: false,
      tools: [tool('get_weather', { defer_loading: true })],
      providerTools: [REGEX_TOOL],
    });

    expect(toolUseFrames(frames)).toEqual([{ type: 'tool_use', text: '', tools: ['toolu_weather'] }]);
    expect(frames.map(f => f.type)).toEqual(['provider_block', 'provider_block', 'content', 'tool_use']);
  });

  it('emits intro text as content and the tool call once on a non-streaming turn', async () => {
    const backend = new RecordingBedrockBackend([], [response([{ type: 'text', text: 'Let me check.' }, weatherCall])]);
    const frames = await wireFrames(backend, { stream: false, tools: [tool('get_weather')] });

    expect(frames).toEqual([
      { type: 'content', text: 'Let me check.' },
      { type: 'tool_use', text: '', tools: ['toolu_weather'] },
    ]);
  });

  it('emits parallel tool calls in one tool_use frame on a non-streaming turn', async () => {
    const backend = new RecordingBedrockBackend(
      [],
      [response([{ type: 'text', text: 'Checking both.' }, weatherCall, timeCall])]
    );
    const frames = await wireFrames(backend, { stream: false, tools: [tool('get_weather'), tool('get_time')] });

    expect(frames).toEqual([
      { type: 'content', text: 'Checking both.' },
      { type: 'tool_use', text: '', tools: ['toolu_weather', 'toolu_time'] },
    ]);
  });

  it('emits one tool_use frame on a streaming tool search turn', async () => {
    const backend = new RecordingBedrockBackend([searchThenToolRound()]);
    const frames = await wireFrames(backend, {
      stream: true,
      tools: [tool('get_weather', { defer_loading: true })],
      providerTools: [REGEX_TOOL],
    });

    expect(toolUseFrames(frames)).toEqual([{ type: 'tool_use', text: '', tools: ['toolu_weather'] }]);
    expect(frames.findIndex(f => f.type === 'tool_use')).toBe(frames.length - 1);
  });
});
