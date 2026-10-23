/**
 * Regression test for #13: streaming Llama completions used to report 0 input tokens
 * because translateStreamChunk never read Bedrock's prompt_token_count/generation_token_count
 * fields (only the non-streaming translateChunk did).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { CompletionInfo } from '@bike4mind/common';
import { ChatModels } from '@bike4mind/common';
import LlamaBedrockBackend from './llama';
import type { ICompletionOptions } from '../backend';

class TestLlamaBackend extends LlamaBedrockBackend {
  protected override updateClientForModel(): void {
    // Skip the real client rebuild so the mock injected below survives.
  }
}

function asBedrockBody(chunks: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) {
        yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(c)) } };
      }
    },
  };
}

describe('LlamaBedrockBackend streaming token reporting', () => {
  it('reports non-zero input/output tokens from the terminal streamed chunk', async () => {
    const backend = new TestLlamaBackend();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => ({
        body: asBedrockBody([
          { generation: 'Hello' },
          { generation: ', world.', prompt_token_count: 50, generation_token_count: 5, stop_reason: 'stop' },
        ]),
      }),
    };

    const calls: { info?: CompletionInfo }[] = [];
    await backend.complete(
      ChatModels.LLAMA3_INSTRUCT_8B_V1,
      [{ role: 'user', content: 'hi' }],
      { stream: true, tools: [] } as Partial<ICompletionOptions>,
      async (_text, info) => {
        calls.push({ info });
      }
    );

    const finalInfo = calls[calls.length - 1]?.info;
    expect(finalInfo).toBeDefined();
    expect(finalInfo!.inputTokens).toBe(50);
    expect(finalInfo!.outputTokens).toBe(5);
  });
});

describe('LlamaBedrockBackend max_gen_len', () => {
  const maxGenLen = (maxTokens: number | undefined) =>
    JSON.parse(
      new LlamaBedrockBackend().getPayload(ChatModels.LLAMA3_INSTRUCT_70B_V1, [{ role: 'user', content: 'hi' }], {
        maxTokens,
      }).body
    ).max_gen_len;

  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(Logger.globalInstance, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it.each([
    [4096, 2048],
    [1000, 1000],
    [undefined, 2048],
    [-5, 1],
    [2048, 2048],
  ])('maxTokens %s sends max_gen_len %s', (maxTokens, expected) => {
    expect(maxGenLen(maxTokens)).toBe(expected);
  });

  it('does not warn when maxTokens is exactly 2048', () => {
    maxGenLen(2048);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [4096, 2048],
    [-5, 1],
  ])('logs a warning when maxTokens %s is clamped to %s', (requested, clamped) => {
    maxGenLen(requested);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('clamping'),
      expect.objectContaining({ model: ChatModels.LLAMA3_INSTRUCT_70B_V1, requested, clamped })
    );
  });

  it('warns once when the same request payload is rebuilt', () => {
    const backend = new LlamaBedrockBackend();
    const options = { maxTokens: 4096 };
    backend.getPayload(ChatModels.LLAMA3_INSTRUCT_70B_V1, [{ role: 'user', content: 'hi' }], options);
    backend.getPayload(ChatModels.LLAMA3_INSTRUCT_70B_V1, [{ role: 'user', content: 'hi' }], options);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('LlamaBedrockBackend preflight output reservation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { model: ChatModels.LLAMA3_INSTRUCT_8B_V1, stream: false },
    { model: ChatModels.LLAMA3_INSTRUCT_8B_V1, stream: true },
    { model: ChatModels.LLAMA3_INSTRUCT_70B_V1, stream: false },
    { model: ChatModels.LLAMA3_INSTRUCT_70B_V1, stream: true },
  ])('preserves a fitting prompt for $model (stream: $stream)', async ({ model, stream }) => {
    vi.spyOn(Logger.globalInstance, 'warn').mockImplementation(() => {});
    const content = ' word'.repeat(4000);
    const response = {
      generation: 'Hello',
      prompt_token_count: 4000,
      generation_token_count: 1,
      stop_reason: 'stop',
    };

    for (const maxTokens of [undefined, 4096, 8192]) {
      const backend = new TestLlamaBackend();
      const send = vi.fn(async (_command: unknown) => ({
        body: stream ? asBedrockBody([response]) : new TextEncoder().encode(JSON.stringify(response)),
      }));
      (backend as unknown as { _bedrockRuntime: unknown })._bedrockRuntime = { send };

      await backend.complete(model, [{ role: 'user', content }], { stream, maxTokens, tools: [] }, async () => {});

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          input: expect.objectContaining({ body: expect.stringContaining('"max_gen_len":2048') }),
        })
      );
      expect(send.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          input: expect.objectContaining({ body: expect.stringContaining(content) }),
        })
      );
    }
  });
});
