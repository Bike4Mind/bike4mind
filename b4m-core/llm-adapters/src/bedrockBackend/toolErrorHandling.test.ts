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
import { MAX_RECORDED_TOOL_RESULT_CHARS, TOOL_RESULT_TRUNCATION_NOTICE } from '../recordToolResult';
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

function makeSucceedingTool(value: string): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'always_throws',
      description: 'Test tool',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    toolFn: async () => value,
  };
}

function lastToolsUsed(calls: CapturedCb[]) {
  for (let i = calls.length - 1; i >= 0; i--) {
    const toolsUsed = calls[i].info?.toolsUsed;
    if (toolsUsed && toolsUsed.length > 0) return toolsUsed;
  }
  return undefined;
}

describe('BaseBedrockBackend tool result recording - non-streaming path', () => {
  it('records returnValue and success:true on a successful round-trip', async () => {
    const backend = new TestBedrockBackend();
    let callIndex = 0;
    const bodies = [
      asBedrockInvokeBody(nonStreamingToolCallChunk()),
      asBedrockInvokeBody(nonStreamingTextChunk('done')),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => ({ body: bodies[callIndex++] }),
    };
    const { calls, cb } = captureCb();

    await backend.complete(
      TEST_MODEL,
      [{ role: 'user', content: 'go' }],
      { stream: false, tools: [makeSucceedingTool('42')], executeTools: true } as Partial<ICompletionOptions>,
      cb
    );

    const toolsUsed = lastToolsUsed(calls);
    expect(toolsUsed).toBeDefined();
    expect(toolsUsed![0].success).toBe(true);
    expect(toolsUsed![0].returnValue).toBe('42');
  });

  it('records success:false with the error text on a failing tool', async () => {
    const backend = new TestBedrockBackend();
    let callIndex = 0;
    const bodies = [
      asBedrockInvokeBody(nonStreamingToolCallChunk()),
      asBedrockInvokeBody(nonStreamingTextChunk('done')),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => ({ body: bodies[callIndex++] }),
    };
    const { calls, cb } = captureCb();

    await backend.complete(
      TEST_MODEL,
      [{ role: 'user', content: 'go' }],
      {
        stream: false,
        tools: [makeThrowingTool(new Error('task parameter is required'))],
        executeTools: true,
      } as Partial<ICompletionOptions>,
      cb
    );

    const toolsUsed = lastToolsUsed(calls);
    expect(toolsUsed).toBeDefined();
    expect(toolsUsed![0].success).toBe(false);
    expect(toolsUsed![0].returnValue).toContain('task parameter is required');
  });

  it('truncates an over-cap result to the cap plus notice length', async () => {
    const backend = new TestBedrockBackend();
    let callIndex = 0;
    const bodies = [
      asBedrockInvokeBody(nonStreamingToolCallChunk()),
      asBedrockInvokeBody(nonStreamingTextChunk('done')),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => ({ body: bodies[callIndex++] }),
    };
    const { calls, cb } = captureCb();
    const longResult = 'x'.repeat(MAX_RECORDED_TOOL_RESULT_CHARS + 500);

    await backend.complete(
      TEST_MODEL,
      [{ role: 'user', content: 'go' }],
      { stream: false, tools: [makeSucceedingTool(longResult)], executeTools: true } as Partial<ICompletionOptions>,
      cb
    );

    const toolsUsed = lastToolsUsed(calls);
    expect(toolsUsed).toBeDefined();
    expect(toolsUsed![0].returnValue?.length).toBe(
      MAX_RECORDED_TOOL_RESULT_CHARS + TOOL_RESULT_TRUNCATION_NOTICE.length
    );
    expect(toolsUsed![0].returnValue?.endsWith(TOOL_RESULT_TRUNCATION_NOTICE)).toBe(true);
  });
});

describe('BaseBedrockBackend tool result recording - streaming path', () => {
  it('records returnValue and success:true on a successful round-trip', async () => {
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
    const { calls, cb } = captureCb();

    await backend.complete(
      TEST_MODEL,
      [{ role: 'user', content: 'go' }],
      { stream: true, tools: [makeSucceedingTool('42')], executeTools: true } as Partial<ICompletionOptions>,
      cb
    );

    const toolsUsed = lastToolsUsed(calls);
    expect(toolsUsed).toBeDefined();
    expect(toolsUsed![0].success).toBe(true);
    expect(toolsUsed![0].returnValue).toBe('42');
  });

  it('records success:false with the error text on a failing tool', async () => {
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
    const { calls, cb } = captureCb();

    await backend.complete(
      TEST_MODEL,
      [{ role: 'user', content: 'go' }],
      {
        stream: true,
        tools: [makeThrowingTool(new Error('task parameter is required'))],
        executeTools: true,
      } as Partial<ICompletionOptions>,
      cb
    );

    const toolsUsed = lastToolsUsed(calls);
    expect(toolsUsed).toBeDefined();
    expect(toolsUsed![0].success).toBe(false);
    expect(toolsUsed![0].returnValue).toContain('task parameter is required');
  });

  it('truncates an over-cap result to the cap plus notice length', async () => {
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
    const { calls, cb } = captureCb();
    const longResult = 'x'.repeat(MAX_RECORDED_TOOL_RESULT_CHARS + 500);

    await backend.complete(
      TEST_MODEL,
      [{ role: 'user', content: 'go' }],
      { stream: true, tools: [makeSucceedingTool(longResult)], executeTools: true } as Partial<ICompletionOptions>,
      cb
    );

    const toolsUsed = lastToolsUsed(calls);
    expect(toolsUsed).toBeDefined();
    expect(toolsUsed![0].returnValue?.length).toBe(
      MAX_RECORDED_TOOL_RESULT_CHARS + TOOL_RESULT_TRUNCATION_NOTICE.length
    );
    expect(toolsUsed![0].returnValue?.endsWith(TOOL_RESULT_TRUNCATION_NOTICE)).toBe(true);
  });

  // This is the one malformed-arguments site Bedrock did not stamp: the catch at the
  // JSON.parse(parameters) resolution step logged and skipped, leaving the toolsUsed entry
  // forever unstamped (arguments unparseable, success undefined) instead of recording a
  // failure like every other backend's equivalent path.
  it('stamps success:false when streamed tool arguments are malformed JSON', async () => {
    const backend = new TestBedrockBackend();
    const turns = [
      [
        { choices: [{ index: 0, status: ChoiceStatus.STREAM, tool: { name: 'always_throws', id: TOOL_CALL_ID } }] },
        { choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText: '{not json' }] },
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
      ],
      streamingTextTurn('done'),
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
    const { calls, cb } = captureCb();

    await backend.complete(
      TEST_MODEL,
      [{ role: 'user', content: 'go' }],
      { stream: true, tools: [makeSucceedingTool('42')], executeTools: true } as Partial<ICompletionOptions>,
      cb
    );

    const toolsUsed = lastToolsUsed(calls);
    expect(toolsUsed).toBeDefined();
    expect(toolsUsed![0].success).toBe(false);
    expect(toolsUsed![0].returnValue).toContain('malformed');
    expect(toolsUsed![0].arguments).toBe('{}');
  });
});
