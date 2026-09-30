/**
 * Non-streaming BaseBedrockBackend with `executeTools: false` (ReActAgent, questMaster, the CLI
 * endpoint): a turn that reports a tool call without running it must still deliver the text the
 * model sent alongside that call. Companion to the executing-branch pin in base.artifactDedupe.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ChatModels, IMessage, ModelInfo, CompletionInfo } from '@bike4mind/common';
import { BaseBedrockBackend } from './base';
import {
  ChoiceEndReason,
  ChoiceStatus,
  type ICompletionOptionTools,
  type ICompletionOptions,
  type ICompletionResponseChunk,
} from '../backend';

const TEST_MODEL = 'test-model' as ChatModels;

class TestBedrockBackend extends BaseBedrockBackend {
  protected override updateClientForModel(): void {}
  async getModelInfo(): Promise<ModelInfo[]> {
    return [];
  }
  formatMessages(messages: IMessage[]): IMessage[] {
    return messages;
  }
  getPayload() {
    return { modelId: 'test', contentType: 'application/json', accept: 'application/json', body: '{}' };
  }
  translateStreamChunk(_model: string, json: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: false, chunk: json as ICompletionResponseChunk };
  }
  translateChunk(_model: string, json: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: true, chunk: json as ICompletionResponseChunk };
  }
  pushToolMessages(): void {}
}

const withBody = (chunk: unknown): TestBedrockBackend => {
  const backend = new TestBedrockBackend();
  const body = new TextEncoder().encode(JSON.stringify(chunk));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = { send: async () => ({ body }) };
  return backend;
};

const toolCallChunk = (chunkText?: string) => ({
  choices: [
    {
      index: 0,
      status: ChoiceStatus.END,
      statusEndReason: ChoiceEndReason.TOOL_USE,
      ...(chunkText !== undefined ? { chunkText } : {}),
      tool: { name: 'search', id: 'tool_search_01', parameters: JSON.stringify({ q: 'bikes' }) },
      usage: { input_tokens: 10, output_tokens: 4 },
    },
  ],
});

const makeSearchTool = () => {
  const toolFn = vi.fn(async () => 'result');
  const tool: ICompletionOptionTools = {
    toolSchema: {
      name: 'search',
      description: 'Search',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    },
    toolFn,
  };
  return { tool, toolFn };
};

async function run(chunk: unknown) {
  const { tool, toolFn } = makeSearchTool();
  const calls: { text: (string | null | undefined)[]; info?: CompletionInfo }[] = [];
  await withBody(chunk).complete(
    TEST_MODEL,
    [{ role: 'user', content: 'find bikes' }],
    { stream: false, tools: [tool], executeTools: false } as Partial<ICompletionOptions>,
    async (text, info) => {
      calls.push({ text, info });
    }
  );
  return { calls, toolFn };
}

describe('BaseBedrockBackend non-streaming executeTools:false', () => {
  it('delivers intro text sharing a chunk with a reported tool call, ahead of the [null] send', async () => {
    const { calls, toolFn } = await run(toolCallChunk("I'll search for that."));

    expect(toolFn).not.toHaveBeenCalled();
    expect(calls.map(c => c.text)).toEqual([["I'll search for that."], [null]]);
    // The reported call rides on both sends, so a consumer sees it with the intro text.
    for (const { info } of calls) {
      expect(info?.toolsUsed).toEqual([
        { name: 'search', arguments: JSON.stringify({ q: 'bikes' }), id: 'tool_search_01' },
      ]);
    }
  });

  it('sends only [null] when the tool call carries no text', async () => {
    const { calls } = await run(toolCallChunk());

    expect(calls.map(c => c.text)).toEqual([[null]]);
  });
});
