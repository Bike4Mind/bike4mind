import { describe, it, expect, vi } from 'vitest';
import { ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { ChatModels, ModelBackend, type CompletionInfo, type IMessage, type ModelInfo } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { ConverseBedrockBackend, CONVERSE_BEDROCK_MODELS } from './converse';
import { UndifferentiatedBedrockBackend } from './undifferentiated';
import { getLlmByModel } from '../index';
import { buildIdentityReminder } from '../identityReminder';
import type { ICompletionOptionTools, ICompletionOptions } from '../backend';

type SentCommand = ConverseCommand | ConverseStreamCommand;

class TestConverseBackend extends ConverseBedrockBackend {
  protected override updateClientForModel(): void {
    // Keep the mock client injected below.
  }
}

function withMockClient(backend: ConverseBedrockBackend, send: (command: SentCommand, opts?: unknown) => unknown) {
  const sent: SentCommand[] = [];
  const spy = vi.fn(async (command: SentCommand, opts?: unknown) => {
    sent.push(command);
    return send(command, opts);
  });
  (backend as unknown as { _bedrockRuntime: { send: typeof spy } })._bedrockRuntime = { send: spy };
  return { sent, spy };
}

function asStream(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) yield event;
    },
  };
}

function collect() {
  const calls: { text: (string | null | undefined)[]; info?: CompletionInfo }[] = [];
  const callback = async (text: (string | null | undefined)[], info?: CompletionInfo) => {
    calls.push({ text, info });
  };
  const joined = () =>
    calls
      .flatMap(c => c.text)
      .filter(Boolean)
      .join('');
  return { calls, callback, joined, last: () => calls[calls.length - 1]?.info };
}

const NOVA = ChatModels.NOVA_PRO_BEDROCK;

const weatherTool = (toolFn: ICompletionOptionTools['toolFn']): ICompletionOptionTools => ({
  toolFn,
  toolSchema: {
    name: 'get_weather',
    description: 'Look up the weather',
    parameters: { type: 'object', properties: { city: { type: 'string', description: 'City' } }, required: ['city'] },
  },
});

describe('ConverseBedrockBackend', () => {
  it('does not count a megabyte image as base64 text in the context preflight', async () => {
    const backend = new TestConverseBackend();
    const { sent } = withMockClient(backend, () => ({
      output: { message: { content: [{ text: 'a cat' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1300, outputTokens: 2 },
    }));
    const bytes = Buffer.alloc(1_100_000, 1);

    await backend.complete(
      NOVA,
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } },
          ],
        },
      ] as IMessage[],
      { stream: false },
      async () => {}
    );

    expect(sent).toHaveLength(1);
    const image = sent[0].input.messages?.[0].content?.[1];
    expect(image).toHaveProperty('image.source.bytes', bytes);
  });

  it('still rejects excessive text accompanying an image before sending', async () => {
    const backend = new TestConverseBackend();
    const { spy } = withMockClient(backend, () => ({}));

    await expect(
      backend.complete(
        NOVA,
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'x'.repeat(1_300_000) },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
            ],
          },
        ] as IMessage[],
        { stream: false },
        async () => {}
      )
    ).rejects.toThrow(/Context overflow/);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([true, false])('continues after a reasoning-only turn-ending tool round (stream=%s)', async stream => {
    const backend = new TestConverseBackend();
    const content = '<thinking>Check the weather first.</thinking>';
    const responses = stream
      ? [
          {
            stream: asStream([
              { messageStart: { role: 'assistant' } },
              { contentBlockDelta: { contentBlockIndex: 0, delta: { text: content } } },
              { contentBlockStop: { contentBlockIndex: 0 } },
              {
                contentBlockStart: {
                  contentBlockIndex: 1,
                  start: { toolUse: { toolUseId: 'tu-end', name: 'get_weather' } },
                },
              },
              { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"city":"Paris"}' } } } },
              { contentBlockStop: { contentBlockIndex: 1 } },
              { messageStop: { stopReason: 'tool_use' } },
            ]),
          },
          {
            stream: asStream([
              { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Sunny.' } } },
              { contentBlockStop: { contentBlockIndex: 0 } },
              { messageStop: { stopReason: 'end_turn' } },
            ]),
          },
        ]
      : [
          {
            output: {
              message: {
                content: [
                  { text: content },
                  { toolUse: { toolUseId: 'tu-end', name: 'get_weather', input: { city: 'Paris' } } },
                ],
              },
            },
            stopReason: 'tool_use',
          },
          { output: { message: { content: [{ text: 'Sunny.' }] } }, stopReason: 'end_turn' },
        ];
    let round = 0;
    const { sent } = withMockClient(backend, () => responses[round++]);
    const toolFn = vi.fn(async () => 'sunny');
    const out = collect();

    await backend.complete(
      NOVA,
      [{ role: 'user', content: 'Weather?' }],
      { stream, tools: [{ ...weatherTool(toolFn), endsTurnAfterText: true }] },
      out.callback
    );

    expect(toolFn).toHaveBeenCalledWith({ city: 'Paris' });
    expect(sent).toHaveLength(2);
    expect(out.joined()).toContain('Sunny.');
  });

  it('reserves the clamped output limit instead of rejecting a valid short request', async () => {
    const backend = new TestConverseBackend();
    const { sent } = withMockClient(backend, () => ({
      output: { message: { content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));

    await backend.complete(NOVA, [{ role: 'user', content: 'hi' }], { maxTokens: 500_000 }, async () => {});

    expect(sent).toHaveLength(1);
    expect(sent[0].input.inferenceConfig?.maxTokens).toBe(10_000);
  });

  it.each([
    ['amazon.nova-pro-v1:0', true],
    ['us.amazon.nova-pro-v1:0', true],
    ['eu.amazon.nova-pro-v1:0', true],
    ['apac.amazon.nova-pro-v1:0', true],
    ['global.amazon.nova-pro-v1:0', true],
    ['us.example.converse-model-v1:0', false],
    ['amazon.novaish-v1:0', false],
  ])('shapes tool schema root keys for %s without changing nested schemas', (model, isNova) => {
    const backend = new TestConverseBackend();
    const tool = weatherTool(async () => '');
    tool.toolSchema.parameters.additionalProperties = false;
    tool.toolSchema.parameters.properties.city.additionalProperties = false;
    const schema = backend.formatToolConfig([tool], 'auto', model).tools[0].toolSpec.inputSchema.json;

    expect(schema).toEqual(
      isNova
        ? {
            type: 'object',
            properties: tool.toolSchema.parameters.properties,
            required: ['city'],
          }
        : tool.toolSchema.parameters
    );
    expect(tool.toolSchema.parameters.additionalProperties).toBe(false);
  });

  it('sends built-in-style Nova tool schemas without unsupported root fields', async () => {
    const backend = new TestConverseBackend();
    const tool = weatherTool(async () => '');
    tool.toolSchema.parameters.additionalProperties = false;
    const { sent } = withMockClient(backend, () => ({
      output: { message: { content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));

    await backend.complete(NOVA, [{ role: 'user', content: 'hi' }], { tools: [tool] }, async () => {});

    expect(sent[0].input.toolConfig?.tools[0]).toEqual({
      toolSpec: {
        name: 'get_weather',
        description: 'Look up the weather',
        inputSchema: {
          json: { type: 'object', properties: tool.toolSchema.parameters.properties, required: ['city'] },
        },
      },
    });
  });

  it('sends a Converse request and returns non-streamed text, usage and stop reason', async () => {
    const backend = new TestConverseBackend();
    const { sent } = withMockClient(backend, () => ({
      output: { message: { role: 'assistant', content: [{ text: 'Hello there.' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 21, outputTokens: 4, totalTokens: 25 },
    }));
    const out = collect();

    await backend.complete(
      NOVA,
      [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
      { stream: false, maxTokens: 50_000, temperature: 0.2 },
      out.callback
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(ConverseCommand);
    const input = sent[0].input;
    expect(input.modelId).toBe(NOVA);
    expect(input.system).toEqual([{ text: `Be brief.\n\n${buildIdentityReminder(NOVA)}` }]);
    expect(input.messages).toEqual([{ role: 'user', content: [{ text: 'hi' }] }]);
    // Clamped to the record's max_tokens.
    expect(input.inferenceConfig).toEqual({ maxTokens: 10_000, temperature: 0.2 });
    expect(input.toolConfig).toBeUndefined();

    expect(out.joined()).toBe('Hello there.');
    expect(out.last()).toMatchObject({ inputTokens: 21, outputTokens: 4, stopReason: 'end_turn' });
  });

  it('streams text and reports usage from the metadata event', async () => {
    const backend = new TestConverseBackend();
    const { sent } = withMockClient(backend, () => ({
      stream: asStream([
        { messageStart: { role: 'assistant' } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Part one, ' } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'part two.' } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'max_tokens' } },
        { metadata: { usage: { inputTokens: 40, outputTokens: 9, totalTokens: 49 } } },
      ]),
    }));
    const out = collect();

    await backend.complete(NOVA, [{ role: 'user', content: 'go' }], { stream: true }, out.callback);

    expect(sent[0]).toBeInstanceOf(ConverseStreamCommand);
    expect(out.joined()).toBe('Part one, part two.');
    expect(out.last()).toMatchObject({ inputTokens: 40, outputTokens: 9, stopReason: 'max_tokens' });
  });

  it('wraps streamed reasoning in one think span', async () => {
    const backend = new TestConverseBackend();
    withMockClient(backend, () => ({
      stream: asStream([
        { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'hmm ' } } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'ok' } } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'Answer.' } } },
        { messageStop: { stopReason: 'end_turn' } },
      ]),
    }));
    const out = collect();

    await backend.complete(NOVA, [{ role: 'user', content: 'q' }], { stream: true }, out.callback);

    expect(out.joined()).toBe('<think>hmm ok</think>Answer.');
  });

  it('suppresses reasoning only for special-task phrases in system turns', async () => {
    const run = async (role: 'user' | 'system') => {
      const backend = new TestConverseBackend();
      withMockClient(backend, () => ({
        stream: asStream([
          { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'hmm' } } } },
          { contentBlockStop: { contentBlockIndex: 0 } },
          { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'Answer.' } } },
          { messageStop: { stopReason: 'end_turn' } },
        ]),
      }));
      const out = collect();
      const messages: IMessage[] =
        role === 'user'
          ? [{ role: 'user', content: 'please give a title to this session' }]
          : [
              { role: 'system', content: 'Give a title to this session.' },
              { role: 'user', content: 'q' },
            ];
      await backend.complete(NOVA, messages, { stream: true }, out.callback);
      return out.joined();
    };

    expect(await run('user')).toBe('<think>hmm</think>Answer.');
    expect(await run('system')).toBe('Answer.');
  });

  it('throws before calling Bedrock when no message survives filtering', async () => {
    const backend = new TestConverseBackend();
    const { spy } = withMockClient(backend, () => ({}));

    await expect(
      backend.complete(NOVA, [{ role: 'system', content: '   ' }], { stream: true }, async () => {})
    ).rejects.toThrow(/no sendable messages/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('runs a streamed tool call and continues with toolUse/toolResult history, accumulating tokens', async () => {
    const backend = new TestConverseBackend();
    const rounds = [
      [
        { messageStart: { role: 'assistant' } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Checking. ' } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'tu-1', name: 'get_weather' } } } },
        { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"city":' } } } },
        { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '"Paris"}' } } } },
        { contentBlockStop: { contentBlockIndex: 1 } },
        { messageStop: { stopReason: 'tool_use' } },
        { metadata: { usage: { inputTokens: 100, outputTokens: 20 } } },
      ],
      [
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'It is sunny.' } } },
        { messageStop: { stopReason: 'end_turn' } },
        { metadata: { usage: { inputTokens: 150, outputTokens: 7 } } },
      ],
    ];
    let round = 0;
    const { sent } = withMockClient(backend, () => ({ stream: asStream(rounds[round++]) }));
    const toolFn = vi.fn(async () => 'sunny, 22C');
    const out = collect();

    await backend.complete(
      NOVA,
      [{ role: 'user', content: 'Weather in Paris?' }],
      { stream: true, tools: [weatherTool(toolFn)] } as Partial<ICompletionOptions>,
      out.callback
    );

    expect(toolFn).toHaveBeenCalledWith({ city: 'Paris' });
    expect(sent).toHaveLength(2);

    expect(sent[0].input.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 'get_weather',
            description: 'Look up the weather',
            inputSchema: { json: weatherTool(toolFn).toolSchema.parameters },
          },
        },
      ],
    });

    const second = sent[1].input;
    expect(second.toolConfig).toBeDefined();
    expect(second.messages).toEqual([
      { role: 'user', content: [{ text: 'Weather in Paris?' }] },
      {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 'tu-1', name: 'get_weather', input: { city: 'Paris' } } }],
      },
      { role: 'user', content: [{ toolResult: { toolUseId: 'tu-1', content: [{ text: 'sunny, 22C' }] } }] },
    ]);

    expect(out.joined()).toContain('Checking. ');
    expect(out.joined()).toContain('It is sunny.');
    expect(out.joined()).not.toContain('Paris"}');
    expect(out.last()).toMatchObject({ inputTokens: 250, outputTokens: 27, stopReason: 'end_turn' });
  });

  it('runs a non-streamed tool call round trip', async () => {
    const backend = new TestConverseBackend();
    const responses = [
      {
        output: {
          message: {
            role: 'assistant',
            content: [{ toolUse: { toolUseId: 'tu-9', name: 'get_weather', input: { city: 'Oslo' } } }],
          },
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 30, outputTokens: 5 },
      },
      {
        output: { message: { role: 'assistant', content: [{ text: 'Cold.' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 45, outputTokens: 2 },
      },
    ];
    let round = 0;
    const { sent } = withMockClient(backend, () => responses[round++]);
    const toolFn = vi.fn(async () => '-3C');
    const out = collect();

    await backend.complete(
      NOVA,
      [{ role: 'user', content: 'Oslo?' }],
      { stream: false, tools: [weatherTool(toolFn)] } as Partial<ICompletionOptions>,
      out.callback
    );

    expect(toolFn).toHaveBeenCalledWith({ city: 'Oslo' });
    expect(sent[1].input.messages?.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 'tu-9', name: 'get_weather', input: { city: 'Oslo' } } }],
      },
      { role: 'user', content: [{ toolResult: { toolUseId: 'tu-9', content: [{ text: '-3C' }] } }] },
    ]);
    expect(out.joined()).toContain('Cold.');
    expect(out.last()).toMatchObject({ inputTokens: 75, outputTokens: 7 });
  });

  it('withholds toolConfig and tool blocks from a model whose record lacks supportsTools', async () => {
    const backend = new TestConverseBackend();
    backend.setDispatchModel({
      ...CONVERSE_BEDROCK_MODELS[0],
      id: 'us.example.text-only-v1:0' as ModelInfo['id'],
      supportsTools: false,
    });
    const { sent } = withMockClient(backend, () => ({
      output: { message: { content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));

    await backend.complete(
      'us.example.text-only-v1:0',
      [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'get_weather', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] },
        { role: 'user', content: 'b' },
      ] as IMessage[],
      { stream: false, tools: [weatherTool(async () => '')] } as Partial<ICompletionOptions>,
      async () => {}
    );

    expect(sent[0].input.toolConfig).toBeUndefined();
    expect(sent[0].input.messages).toEqual([{ role: 'user', content: [{ text: 'a\n\nb' }] }]);
  });

  it('sends a data-URL image as decoded bytes', async () => {
    const backend = new TestConverseBackend();
    const { sent } = withMockClient(backend, () => ({
      output: { message: { content: [{ text: 'a cat' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const bytes = Buffer.from('fake-png');

    await backend.complete(
      NOVA,
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } },
          ],
        },
      ] as IMessage[],
      { stream: false },
      async () => {}
    );

    const content = sent[0].input.messages?.[0].content ?? [];
    expect(content[0]).toEqual({ text: 'What is this?' });
    const image = (content[1] as { image: { format: string; source: { bytes: Uint8Array } } }).image;
    expect(image.format).toBe('png');
    expect(Buffer.from(image.source.bytes).equals(bytes)).toBe(true);
  });

  it('forwards the abort signal to the client', async () => {
    const backend = new TestConverseBackend();
    const { spy } = withMockClient(backend, () => ({
      stream: asStream([
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'x' } } },
        { messageStop: { stopReason: 'end_turn' } },
      ]),
    }));
    const controller = new AbortController();

    await backend.complete(
      NOVA,
      [{ role: 'user', content: 'go' }],
      { stream: true, abortSignal: controller.signal },
      async () => {}
    );

    expect(spy.mock.calls[0][1]).toEqual({ abortSignal: controller.signal });
  });

  it('fails loud on a stream that ends without messageStop', async () => {
    const backend = new TestConverseBackend();
    withMockClient(backend, () => ({
      stream: asStream([{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'half an ans' } } }]),
    }));

    await expect(
      backend.complete(NOVA, [{ role: 'user', content: 'go' }], { stream: true }, async () => {})
    ).rejects.toThrow(/TRUNCATED/);
  });
});

describe('inline thinking tags', () => {
  const streamText = async (deltas: string[], messages: IMessage[] = [{ role: 'user', content: 'q' }]) => {
    const backend = new TestConverseBackend();
    withMockClient(backend, () => ({
      stream: asStream([
        { messageStart: { role: 'assistant' } },
        ...deltas.map(text => ({ contentBlockDelta: { contentBlockIndex: 0, delta: { text } } })),
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'end_turn' } },
      ]),
    }));
    const out = collect();
    await backend.complete(NOVA, messages, { stream: true }, out.callback);
    return out.joined();
  };
  const titleMessages: IMessage[] = [
    { role: 'system', content: 'Give a title to this session.' },
    { role: 'user', content: 'q' },
  ];

  it('moves non-streamed inline thinking into a think span', async () => {
    const backend = new TestConverseBackend();
    withMockClient(backend, () => ({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: '<thinking> use math_evaluate </thinking>\n\nThe product is 391.' }],
        },
      },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const out = collect();
    await backend.complete(NOVA, [{ role: 'user', content: 'q' }], { stream: false }, out.callback);
    expect(out.joined()).toBe('<think> use math_evaluate </think>The product is 391.');
  });

  it('handles tags split across streamed deltas', async () => {
    const text = await streamText(['<thi', 'nking> plan it </thin', 'king>', '\n', 'Answer ', '<th', 'is stays']);
    expect(text).toBe('<think> plan it </think>Answer <this stays');
  });

  it('drops inline thinking for special tasks', async () => {
    expect(await streamText(['<thinking>hmm</thinking>\n', 'Title'], titleMessages)).toBe('Title');
  });

  it('closes an unclosed span at stream end', async () => {
    expect(await streamText(['Hi <thinking>trailing', ' thought'])).toBe('Hi <think>trailing thought</think>');
  });

  it('leaves text without the tag untouched', async () => {
    expect(await streamText(['I was thinking about it'])).toBe('I was thinking about it');
  });

  it('passes the tag through for a model without the field', async () => {
    const record: ModelInfo = {
      ...CONVERSE_BEDROCK_MODELS[0],
      id: 'us.example.converse-model-v1:0' as ModelInfo['id'],
    };
    const backend = new TestConverseBackend();
    backend.setDispatchModel(record);
    withMockClient(backend, () => ({
      stream: asStream([
        { messageStart: { role: 'assistant' } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: '<thinking>x</thinking> y' } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: 'end_turn' } },
      ]),
    }));
    const out = collect();
    await backend.complete(String(record.id), [{ role: 'user', content: 'q' }], { stream: true }, out.callback);
    expect(out.joined()).toBe('<thinking>x</thinking> y');
  });
});

describe('adding a Converse model is an enum entry plus a ModelInfo record', () => {
  const logger = new Logger();

  it.each(CONVERSE_BEDROCK_MODELS.map(m => [String(m.id), m] as const))(
    '%s is listed by the Bedrock aggregator and routed to ConverseBedrockBackend',
    async (id, record) => {
      expect(record.backend).toBe(ModelBackend.Bedrock);
      expect(Object.values(ChatModels)).toContain(id);

      const listed = await new UndifferentiatedBedrockBackend().getModelInfo();
      expect(listed.filter(m => String(m.id) === id)).toEqual([record]);

      expect(getLlmByModel({}, { modelInfo: record, logger })).toBeInstanceOf(ConverseBedrockBackend);
    }
  );

  it('routes a catalog-only record in the bedrock-converse family and shapes it from that record', async () => {
    const record: ModelInfo = {
      ...CONVERSE_BEDROCK_MODELS[0],
      id: 'us.example.converse-model-v1:0' as ModelInfo['id'],
      max_tokens: 2048,
      adapterFamily: 'bedrock-converse',
    };
    const backend = getLlmByModel({}, { modelInfo: record, logger });
    expect(backend).toBeInstanceOf(ConverseBedrockBackend);

    const payload = JSON.parse(
      (backend as ConverseBedrockBackend).getPayload(String(record.id), [{ role: 'user', content: 'hi' }], {
        tools: [weatherTool(async () => '')],
      }).body
    );
    expect(payload.modelId).toBe(record.id);
    expect(payload.inferenceConfig.maxTokens).toBe(2048);
    expect(payload.toolConfig.tools[0].toolSpec.name).toBe('get_weather');
  });

  it('leaves an id outside every Bedrock table unrouted', () => {
    const record = { ...CONVERSE_BEDROCK_MODELS[0], id: 'unknown.model-v1:0' as ModelInfo['id'] };
    expect(getLlmByModel({}, { modelInfo: record, logger })).toBeNull();
  });
});
