/**
 * Regression test for tool error handling in BaseBedrockBackend.
 *
 * Before this fix the non-streaming path called `toolFn(...)` without a
 * try/catch - any thrown error escaped `complete()`, propagated to the
 * Lambda runtime and crashed the invocation. The streaming path already
 * caught tool errors via `executeToolsBatch` and surfaced them to the
 * model as a `tool_result`. This file pins both behaviours.
 */

import { describe, it, expect } from 'vitest';
import { PermissionDeniedError } from '@bike4mind/common';
import type { ChatModels, IMessage, ModelInfo, CompletionInfo } from '@bike4mind/common';
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
  protected override updateClientForModel(_model: string): void {
    // intentionally empty - keep the test-injected _bedrockRuntime mock
  }

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

function asBedrockInvokeBody(chunk: unknown) {
  return new TextEncoder().encode(JSON.stringify(chunk));
}

interface CapturedCb {
  text: (string | null | undefined)[];
  info?: CompletionInfo;
}

function captureCb() {
  const calls: CapturedCb[] = [];
  return {
    calls,
    cb: async (text: (string | null | undefined)[], info?: CompletionInfo) => {
      calls.push({ text, info });
    },
  };
}

const TEST_MODEL = 'test-model' as ChatModels;

const TOOL_CALL_ID = 'tool_throws_01';

function makeThrowingTool(err: unknown): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'always_throws',
      description: 'Test tool that always throws',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    toolFn: async () => {
      throw err;
    },
  };
}

function streamingToolCallTurn(): unknown[] {
  return [
    {
      choices: [{ index: 0, status: ChoiceStatus.STREAM, tool: { name: 'always_throws', id: TOOL_CALL_ID } }],
    },
    { choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText: '{}' }] },
    {
      choices: [
        {
          index: 0,
          status: ChoiceStatus.END,
          statusEndReason: ChoiceEndReason.STOP,
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      ],
    },
  ];
}

function streamingTextTurn(text: string): unknown[] {
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

function nonStreamingToolCallChunk() {
  return {
    choices: [
      {
        index: 0,
        status: ChoiceStatus.END,
        statusEndReason: ChoiceEndReason.TOOL_USE,
        tool: { name: 'always_throws', id: TOOL_CALL_ID, parameters: '{}' },
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ],
  };
}

function nonStreamingTextChunk(text: string) {
  return {
    choices: [
      {
        index: 0,
        status: ChoiceStatus.END,
        statusEndReason: ChoiceEndReason.STOP,
        chunkText: text,
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    ],
  };
}

describe('BaseBedrockBackend tool error handling — non-streaming path', () => {
  it('catches a thrown tool error, surfaces it as tool_result, and continues the conversation', async () => {
    const backend = new TestBedrockBackend();
    let callIndex = 0;
    const bodies = [
      asBedrockInvokeBody(nonStreamingToolCallChunk()),
      asBedrockInvokeBody(nonStreamingTextChunk('recovered after tool error')),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => ({ body: bodies[callIndex++] }),
    };

    const messages: IMessage[] = [{ role: 'user', content: 'trigger the bad tool' }];
    const { cb } = captureCb();

    await expect(
      backend.complete(
        TEST_MODEL,
        messages,
        {
          stream: false,
          tools: [makeThrowingTool(new Error('task parameter is required'))],
          executeTools: true,
        } as Partial<ICompletionOptions>,
        cb
      )
    ).resolves.not.toThrow();

    expect(callIndex).toBe(2);

    const toolResultMsg = messages.find(
      m =>
        Array.isArray(m.content) &&
        m.content.some(
          (c: unknown) => typeof c === 'object' && c !== null && (c as { type?: string }).type === 'tool_result'
        )
    );
    expect(toolResultMsg).toBeDefined();
    const toolResultBlock = (toolResultMsg!.content as Array<{ type: string; content: string }>).find(
      c => c.type === 'tool_result'
    );
    expect(toolResultBlock?.content).toContain('Error processing always_throws tool');
    expect(toolResultBlock?.content).toContain('task parameter is required');
  });

  it('re-throws PermissionDeniedError instead of swallowing it as a tool_result', async () => {
    const backend = new TestBedrockBackend();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => ({ body: asBedrockInvokeBody(nonStreamingToolCallChunk()) }),
    };

    const { cb } = captureCb();

    await expect(
      backend.complete(
        TEST_MODEL,
        [{ role: 'user', content: 'permission test' }],
        {
          stream: false,
          tools: [makeThrowingTool(new PermissionDeniedError('always_throws'))],
          executeTools: true,
        } as Partial<ICompletionOptions>,
        cb
      )
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('propagates abort errors instead of swallowing them as a tool_result', async () => {
    const backend = new TestBedrockBackend();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => ({ body: asBedrockInvokeBody(nonStreamingToolCallChunk()) }),
    };

    const { cb } = captureCb();

    await expect(
      backend.complete(
        TEST_MODEL,
        [{ role: 'user', content: 'abort test' }],
        {
          stream: false,
          tools: [makeThrowingTool(new Error('Request aborted by user'))],
          executeTools: true,
        } as Partial<ICompletionOptions>,
        cb
      )
    ).rejects.toThrow(/aborted/);
  });

  it('propagates canonical AbortError (name === "AbortError") even when message lacks the word', async () => {
    const backend = new TestBedrockBackend();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => ({ body: asBedrockInvokeBody(nonStreamingToolCallChunk()) }),
    };

    const abortErr = new Error('The operation was cancelled');
    abortErr.name = 'AbortError';

    const { cb } = captureCb();

    await expect(
      backend.complete(
        TEST_MODEL,
        [{ role: 'user', content: 'abort by name' }],
        {
          stream: false,
          tools: [makeThrowingTool(abortErr)],
          executeTools: true,
        } as Partial<ICompletionOptions>,
        cb
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('propagates Node-style abort errors (code === "ABORT_ERR")', async () => {
    const backend = new TestBedrockBackend();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => ({ body: asBedrockInvokeBody(nonStreamingToolCallChunk()) }),
    };

    const abortErr = Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' });

    const { cb } = captureCb();

    await expect(
      backend.complete(
        TEST_MODEL,
        [{ role: 'user', content: 'abort by code' }],
        {
          stream: false,
          tools: [makeThrowingTool(abortErr)],
          executeTools: true,
        } as Partial<ICompletionOptions>,
        cb
      )
    ).rejects.toMatchObject({ message: 'cancelled' });
  });
});

describe('BaseBedrockBackend tool error handling — streaming path', () => {
  it('catches a thrown tool error and surfaces it as tool_result (regression for the existing path)', async () => {
    const backend = new TestBedrockBackend();
    const turns = [streamingToolCallTurn(), streamingTextTurn('done')];
    let callIndex = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => {
        const turn = turns[callIndex++];
        if (!turn) throw new Error('no more mocked turns');
        return { body: asBedrockStreamBody(turn) };
      },
    };

    const messages: IMessage[] = [{ role: 'user', content: 'trigger the bad tool' }];
    const { cb } = captureCb();

    await expect(
      backend.complete(
        TEST_MODEL,
        messages,
        {
          stream: true,
          tools: [makeThrowingTool(new Error('task parameter is required'))],
          executeTools: true,
        } as Partial<ICompletionOptions>,
        cb
      )
    ).resolves.not.toThrow();

    const toolResultMsg = messages.find(
      m =>
        Array.isArray(m.content) &&
        m.content.some(
          (c: unknown) => typeof c === 'object' && c !== null && (c as { type?: string }).type === 'tool_result'
        )
    );
    expect(toolResultMsg).toBeDefined();
    const toolResultBlock = (toolResultMsg!.content as Array<{ type: string; content: string }>).find(
      c => c.type === 'tool_result'
    );
    expect(toolResultBlock?.content).toContain('Error processing always_throws tool');
    expect(toolResultBlock?.content).toContain('task parameter is required');
  });

  it('propagates abort errors instead of swallowing them as a tool_result', async () => {
    const backend = new TestBedrockBackend();
    const turns = [streamingToolCallTurn()];
    let callIndex = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => {
        const turn = turns[callIndex++];
        if (!turn) throw new Error('no more mocked turns');
        return { body: asBedrockStreamBody(turn) };
      },
    };

    const { cb } = captureCb();

    await expect(
      backend.complete(
        TEST_MODEL,
        [{ role: 'user', content: 'abort test' }],
        {
          stream: true,
          tools: [makeThrowingTool(new Error('Request aborted by user'))],
          executeTools: true,
        } as Partial<ICompletionOptions>,
        cb
      )
    ).rejects.toThrow(/aborted/);
  });
});
