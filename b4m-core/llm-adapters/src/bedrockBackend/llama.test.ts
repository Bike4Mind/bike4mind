/**
 * Regression test for #13: streaming Llama completions used to report 0 input tokens
 * because translateStreamChunk never read Bedrock's prompt_token_count/generation_token_count
 * fields (only the non-streaming translateChunk did).
 */

import { describe, it, expect } from 'vitest';
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
