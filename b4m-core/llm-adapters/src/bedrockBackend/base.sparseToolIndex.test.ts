/**
 * Regression test: the streaming loop in BaseBedrockBackend indexes tool calls by the
 * provider's choice index, so a tool at index >= 2 leaves holes in the array that the tool
 * loops must skip rather than destructure.
 */
import { describe, it, expect } from 'vitest';
import type { ChatModels, IMessage, ModelInfo } from '@bike4mind/common';
import { BaseBedrockBackend } from './base';
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
const TOOL_CALL_ID = 'tool_echo_01';

function toolCallTurnAtIndex(index: number): unknown[] {
  return [
    { choices: [{ index, status: ChoiceStatus.STREAM, tool: { name: 'echo', id: TOOL_CALL_ID } }] },
    { choices: [{ index, status: ChoiceStatus.STREAM, chunkText: JSON.stringify({ value: 'hi' }) }] },
    {
      choices: [
        {
          index,
          status: ChoiceStatus.END,
          statusEndReason: ChoiceEndReason.STOP,
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      ],
    },
  ];
}

function textTurn(text: string): unknown[] {
  return [
    { choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText: text }] },
    {
      choices: [
        {
          index: 0,
          status: ChoiceStatus.END,
          statusEndReason: ChoiceEndReason.STOP,
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      ],
    },
  ];
}

async function runStreamingToolCallAtIndex(index: number) {
  const backend = new TestBedrockBackend();
  const turns = [toolCallTurnAtIndex(index), textTurn('done')];
  let callIndex = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
    send: async () => {
      const turn = turns[callIndex++];
      if (!turn) throw new Error('no more mocked turns');
      return { body: asBedrockStreamBody(turn) };
    },
  };

  let toolRuns = 0;
  const echoTool: ICompletionOptionTools = {
    toolSchema: {
      name: 'echo',
      description: 'Echo a value',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    },
    toolFn: async () => {
      toolRuns++;
      return 'echoed';
    },
  };

  const messages: IMessage[] = [{ role: 'user', content: 'call the tool' }];
  await backend.complete(
    TEST_MODEL,
    messages,
    { stream: true, tools: [echoTool], executeTools: true } as Partial<ICompletionOptions>,
    async () => {}
  );

  return { toolRuns };
}

describe('BaseBedrockBackend streaming tool calls at a sparse choice index', () => {
  it('runs a tool at index 2 exactly once instead of destructuring the holes', async () => {
    const { toolRuns } = await runStreamingToolCallAtIndex(2);
    expect(toolRuns).toBe(1);
  });

  it('runs a tool at index 3 with nothing at indices 1-2 exactly once', async () => {
    const { toolRuns } = await runStreamingToolCallAtIndex(3);
    expect(toolRuns).toBe(1);
  });

  it('still runs a tool at index 0 exactly once', async () => {
    const { toolRuns } = await runStreamingToolCallAtIndex(0);
    expect(toolRuns).toBe(1);
  });
});
