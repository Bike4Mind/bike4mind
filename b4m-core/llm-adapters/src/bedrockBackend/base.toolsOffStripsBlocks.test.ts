/**
 * A replayed history turn (utils.ts Priority 2) can carry perfectly-paired tool_use/
 * tool_result blocks from a PRIOR turn even when the CURRENT turn offers no tools.
 * Bedrock talks the same Anthropic Messages API as anthropicBackend.ts and rejects any
 * tool block when `tools` is absent regardless of pairing - mirrors
 * anthropicBackend.toolsOffStripsBlocks.test.ts for the Bedrock path.
 */
import { describe, it, expect } from 'vitest';
import type { ChatModels, IMessage, ModelInfo } from '@bike4mind/common';
import { BaseBedrockBackend } from './base';
import { ChoiceEndReason, ChoiceStatus, type ICompletionOptions, type ICompletionResponseChunk } from '../backend';

class TestBedrockBackend extends BaseBedrockBackend {
  capturedMessages: IMessage[][] = [];

  protected override updateClientForModel(_model: string): void {
    // intentionally empty - keep the test-injected _bedrockRuntime mock
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return [];
  }

  formatMessages(messages: IMessage[]): IMessage[] {
    return messages;
  }

  getPayload(
    _model: string,
    formattedMessages: IMessage[]
  ): { modelId: string; contentType: string; accept: string; body: string } {
    this.capturedMessages.push(formattedMessages);
    return { modelId: 'test', contentType: 'application/json', accept: 'application/json', body: '{}' };
  }

  translateStreamChunk(_model: string, json: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: false, chunk: json as ICompletionResponseChunk };
  }

  translateChunk(_model: string, json: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: true, chunk: json as ICompletionResponseChunk };
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

const TEST_MODEL = 'test-model' as ChatModels;

const replayedMessages: IMessage[] = [
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'reply 1' },
      { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'weather' } },
    ],
  } as IMessage,
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny', is_error: false }],
  } as IMessage,
  { role: 'user', content: 'and tomorrow?' },
];

describe('BaseBedrockBackend - strips tool blocks when the current turn offers no tools', () => {
  it('strips paired tool_use/tool_result blocks from a replayed turn when options.tools is empty', async () => {
    const backend = new TestBedrockBackend();
    (backend as unknown as { _bedrockRuntime: unknown })._bedrockRuntime = {
      send: async () => ({ body: asBedrockStreamBody(streamingTextTurn('ok')) }),
    };

    await backend.complete(
      TEST_MODEL,
      replayedMessages,
      { stream: true, tools: [] } as Partial<ICompletionOptions>,
      async () => {}
    );

    const sent = backend.capturedMessages[0];
    const hasToolBlock = sent.some(
      m => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_use' || b.type === 'tool_result')
    );
    expect(hasToolBlock).toBe(false);
  });

  it('leaves tool blocks intact when the current turn DOES offer tools', async () => {
    const backend = new TestBedrockBackend();
    (backend as unknown as { _bedrockRuntime: unknown })._bedrockRuntime = {
      send: async () => ({ body: asBedrockStreamBody(streamingTextTurn('ok')) }),
    };

    await backend.complete(
      TEST_MODEL,
      replayedMessages,
      {
        stream: true,
        tools: [
          {
            toolSchema: { name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} } },
            toolFn: async () => 'sunny',
          },
        ],
      } as Partial<ICompletionOptions>,
      async () => {}
    );

    const sent = backend.capturedMessages[0];
    const hasToolUse = sent.some(m => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_use'));
    expect(hasToolUse).toBe(true);
  });
});
