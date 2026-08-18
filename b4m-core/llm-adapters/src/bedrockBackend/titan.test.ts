/**
 * Regression test for #13: streaming Titan completions used to report 0 input tokens
 * because translateStreamChunk never read Bedrock's inputTextTokenCount/totalOutputTextTokenCount
 * fields (only the non-streaming translateChunk did).
 */

import { describe, it, expect } from 'vitest';
import type { CompletionInfo } from '@bike4mind/common';
import { ChatModels } from '@bike4mind/common';
import TitanBedrockBackend from './titan';
import type { ICompletionOptions } from '../backend';

class TestTitanBackend extends TitanBedrockBackend {
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

describe('TitanBedrockBackend streaming token reporting', () => {
  it('reports non-zero input/output tokens from each streamed chunk', async () => {
    const backend = new TestTitanBackend();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => ({
        body: asBedrockBody([
          {
            index: 0,
            inputTextTokenCount: 40,
            totalOutputTextTokenCount: 3,
            outputText: 'Hello',
            completionReason: 'FINISH',
          },
          {
            index: 0,
            inputTextTokenCount: 40,
            totalOutputTextTokenCount: 6,
            outputText: ', world.',
            completionReason: 'FINISH',
          },
        ]),
      }),
    };

    const calls: { info?: CompletionInfo }[] = [];
    await backend.complete(
      ChatModels.TITAN_TEXT_G1_EXPRESS,
      [{ role: 'user', content: 'hi' }],
      { stream: true, tools: [] } as Partial<ICompletionOptions>,
      async (_text, info) => {
        calls.push({ info });
      }
    );

    const finalInfo = calls[calls.length - 1]?.info;
    expect(finalInfo).toBeDefined();
    expect(finalInfo!.inputTokens).toBe(40);
    expect(finalInfo!.outputTokens).toBe(6);
  });
});
