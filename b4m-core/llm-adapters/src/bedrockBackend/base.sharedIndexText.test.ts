/**
 * Regression tests for prose that shares a choice index with a streaming tool call. The base loop
 * must keep that prose out of the tool's arguments (case A) and still deliver it to the client
 * when it arrives in the same frame as the tool header (case B).
 */
import { describe, it, expect } from 'vitest';
import { ChatModels, type IMessage, type ModelInfo, type CompletionInfo } from '@bike4mind/common';
import { BaseBedrockBackend } from './base';
import MoonshotBedrockBackend from './moonshot';
import {
  ChoiceEndReason,
  ChoiceStatus,
  type IChoiceEndToolUse,
  type ICompletionOptionTools,
  type ICompletionOptions,
  type ICompletionResponseChunk,
} from '../backend';

class TestBedrockBackend extends BaseBedrockBackend {
  protected override updateClientForModel(_model: string): void {}

  async getModelInfo(): Promise<ModelInfo[]> {
    return [];
  }

  formatMessages(messages: IMessage[]): IMessage[] {
    return messages;
  }

  getPayload(): { modelId: string; contentType: string; accept: string; body: string } {
    return { modelId: 'test', contentType: 'application/json', accept: 'application/json', body: '{}' };
  }

  translateStreamChunk(_model: string, json: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: false, chunk: json as ICompletionResponseChunk };
  }

  translateChunk(_model: string, json: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: true, chunk: json as ICompletionResponseChunk };
  }

  pushToolMessages(messages: IMessage[], tool: IChoiceEndToolUse['tool'], result: string): void {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: tool.id, name: tool.name, input: JSON.parse(tool.parameters || '{}') }],
    } as IMessage);
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: tool.id, content: result }],
    } as IMessage);
  }
}

function asBedrockStreamBody(chunks: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) {
        yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(c)) } };
      }
    },
  };
}

const TEST_MODEL = 'test-model' as ChatModels;
const TOOL = { name: 'calc', id: 'tool_calc_01' };
const ARGS = JSON.stringify({ x: '12*15' });

const END_FRAME = {
  choices: [
    {
      index: 0,
      status: ChoiceStatus.END,
      statusEndReason: ChoiceEndReason.STOP,
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  ],
};

const header = { index: 0, status: ChoiceStatus.STREAM, tool: TOOL };
const args = { index: 0, status: ChoiceStatus.STREAM, chunkText: ARGS };
const prose = (text: string) => ({ index: 0, status: ChoiceStatus.STREAM, chunkText: text, toolArguments: false });

class TestMoonshotBackend extends MoonshotBedrockBackend {
  protected override updateClientForModel(_model: string): void {}
}

async function run(
  firstTurn: unknown[],
  backend: BaseBedrockBackend = new TestBedrockBackend(),
  secondTurn?: unknown[],
  extraToolNames: string[] = []
) {
  const calls: Record<string, unknown[]> = {};
  const makeTool = (name: string): ICompletionOptionTools => ({
    toolSchema: {
      name,
      description: 'Test tool',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    },
    toolFn: async (params: unknown) => {
      (calls[name] ??= []).push(params);
      return '180';
    },
  });
  const tools = ['calc', ...extraToolNames].map(makeTool);
  const turns = [
    firstTurn,
    secondTurn ?? [{ choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText: 'done' }] }, END_FRAME],
  ];
  let callIndex = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
    send: async () => {
      const turn = turns[callIndex++];
      if (!turn) throw new Error('no more mocked turns');
      return { body: asBedrockStreamBody(turn) };
    },
  };

  const texts: string[] = [];
  const cb = async (text: (string | null | undefined)[], _info?: CompletionInfo) => {
    for (const t of text) if (typeof t === 'string') texts.push(t);
  };
  await backend.complete(
    backend instanceof MoonshotBedrockBackend ? ChatModels.KIMI_K2_THINKING_BEDROCK : TEST_MODEL,
    [{ role: 'user', content: 'what is 12*15' }],
    { stream: true, tools, executeTools: true } as Partial<ICompletionOptions>,
    cb
  );
  return { toolCalls: calls.calc ?? [], calls, clientText: texts.join('') };
}

describe('BaseBedrockBackend streaming prose that shares a tool call index', () => {
  it('case A: prose in a later frame does not corrupt the tool arguments', async () => {
    const { toolCalls, clientText } = await run([
      { choices: [header] },
      { choices: [prose('LATE-TEXT')] },
      { choices: [{ ...args, toolArguments: true }] },
      END_FRAME,
    ]);

    expect(toolCalls).toEqual([{ x: '12*15' }]);
    expect(clientText).toContain('LATE-TEXT');
  });

  it('case B: prose in the same frame as the tool header reaches the client', async () => {
    const { toolCalls, clientText } = await run([
      { choices: [prose('INTRO-TEXT'), header] },
      { choices: [{ ...args, toolArguments: true }] },
      END_FRAME,
    ]);

    expect(toolCalls).toEqual([{ x: '12*15' }]);
    expect(clientText).toContain('INTRO-TEXT');
  });

  it('control: an unmarked argument fragment still accumulates and the tool runs once', async () => {
    const { toolCalls, clientText } = await run([{ choices: [header] }, { choices: [args] }, END_FRAME]);

    expect(toolCalls).toEqual([{ x: '12*15' }]);
    expect(clientText).not.toContain('12*15');
  });

  it('control: text from an earlier frame is still delivered before the tool call', async () => {
    const { toolCalls, clientText } = await run([
      { choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText: 'EARLY-TEXT' }] },
      { choices: [header] },
      { choices: [args] },
      END_FRAME,
    ]);

    expect(toolCalls).toEqual([{ x: '12*15' }]);
    expect(clientText).toContain('EARLY-TEXT');
  });

  it('control: unflagged text at another index while a tool streams is still dropped, as on main', async () => {
    const { toolCalls, clientText } = await run([
      { choices: [header] },
      { choices: [{ index: 1, status: ChoiceStatus.STREAM, chunkText: 'POST-TOOL-TEXT' }] },
      { choices: [args] },
      END_FRAME,
    ]);

    expect(toolCalls).toEqual([{ x: '12*15' }]);
    expect(clientText).not.toContain('POST-TOOL-TEXT');
  });

  // Moonshot emits a native tool header only once the call closes, so its case B is intro
  // monologue plus the whole call inside one <reasoning> delta.
  it('Moonshot through the real base loop: same-frame monologue is delivered and the tool runs once', async () => {
    const { toolCalls, clientText } = await run(
      [
        {
          choices: [
            {
              delta: {
                content:
                  '<reasoning> INTRO-TEXT <|tool_calls_section_begin|> <|tool_call_begin|> functions.calc:0 <|tool_call_argument_begin|> {"x":"12*15"} <|tool_call_end|> <|tool_calls_section_end|></reasoning>',
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ],
      new TestMoonshotBackend(),
      [{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]
    );

    expect(toolCalls).toEqual([{ x: '12*15' }]);
    expect(clientText).toContain('INTRO-TEXT');
    expect(clientText).not.toContain('<|');
  });

  // Frames captured verbatim from live moonshot.kimi-k2-thinking: a two-tool turn whose native
  // <|tool_call...|> tokens arrive inside the reasoning stream, split mid-argument across frames.
  it('Moonshot through the real base loop: parallel native tool calls run with intact args and no token leak', async () => {
    const reasoning = (content: string, extra: Record<string, unknown> = {}) => ({
      choices: [{ delta: { content: `<reasoning>${content}</reasoning>` }, ...extra }],
    });
    const { calls, clientText } = await run(
      [
        reasoning(
          " I'll compute the math problem and get the weather for Paris for you. <|tool_calls_section_begin|> <|tool_call_begin|> functions.math_evaluate:0 <|tool_call_argument_begin|>"
        ),
        reasoning(
          ' {"expression": "12*15"} <|tool_call_end|> <|tool_call_begin|> functions.get_weather:1 <|tool_call_argument_begin|> {"city": "Paris'
        ),
        {
          ...reasoning('"} <|tool_call_end|> <|tool_calls_section_end|>', { finish_reason: 'stop' }),
          'amazon-bedrock-invocationMetrics': { inputTokenCount: 236, outputTokenCount: 49 },
        },
      ],
      new TestMoonshotBackend(),
      [{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }],
      ['math_evaluate', 'get_weather']
    );

    expect(calls.math_evaluate).toEqual([{ expression: '12*15' }]);
    expect(calls.get_weather).toEqual([{ city: 'Paris' }]);
    expect(clientText).toContain("I'll compute the math problem");
    expect(clientText).not.toContain('<|');
  });
});
