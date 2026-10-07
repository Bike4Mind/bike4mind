/**
 * A tool that throws is recorded on toolsUsed as success:false with the thrown message in
 * returnValue. Answer Diagnosis (common/src/utils/answerDiagnosis.ts) reads that text to name a
 * timeout, so both executing branches of BaseBedrockBackend are pinned here.
 */
import { describe, it, expect } from 'vitest';
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
const TOOL_ID = 'tool_web_search_01';
const PARAMS = JSON.stringify({ query: 'bikes' });
const TIMEOUT_MESSAGE = 'Web search timed out: SerpAPI did not respond within 10s (tried 2 times)';

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

const webSearchTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'web_search',
    description: 'Search the web',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  toolFn: async () => {
    throw new Error(TIMEOUT_MESSAGE);
  },
};

const end = (statusEndReason: ChoiceEndReason, extra: Record<string, unknown> = {}) => ({
  choices: [
    { index: 0, status: ChoiceStatus.END, statusEndReason, usage: { input_tokens: 5, output_tokens: 2 }, ...extra },
  ],
});

const encode = (chunk: unknown) => new TextEncoder().encode(JSON.stringify(chunk));

const streamBody = (chunks: unknown[]) => ({
  [Symbol.asyncIterator]: async function* () {
    for (const c of chunks) yield { chunk: { bytes: encode(c) } };
  },
});

const responses = {
  nonStreaming: [
    { body: encode(end(ChoiceEndReason.TOOL_USE, { tool: { name: 'web_search', id: TOOL_ID, parameters: PARAMS } })) },
    { body: encode(end(ChoiceEndReason.STOP, { chunkText: 'Search is unavailable.' })) },
  ],
  streaming: [
    {
      body: streamBody([
        { choices: [{ index: 0, status: ChoiceStatus.STREAM, tool: { name: 'web_search', id: TOOL_ID } }] },
        { choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText: PARAMS }] },
        end(ChoiceEndReason.STOP),
      ]),
    },
    {
      body: streamBody([
        { choices: [{ index: 0, status: ChoiceStatus.STREAM, chunkText: 'Search is unavailable.' }] },
        end(ChoiceEndReason.STOP),
      ]),
    },
  ],
};

describe('BaseBedrockBackend records a thrown tool error on toolsUsed', () => {
  it.each([
    ['non-streaming', false, responses.nonStreaming],
    ['streaming', true, responses.streaming],
  ] as const)('%s: success:false with the thrown message in returnValue', async (_label, stream, bodies) => {
    const backend = new TestBedrockBackend();
    let callIndex = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = { send: async () => bodies[callIndex++] };

    const infos: CompletionInfo[] = [];
    await backend.complete(
      TEST_MODEL,
      [{ role: 'user', content: 'find bikes' }],
      { stream, tools: [webSearchTool], executeTools: true } as Partial<ICompletionOptions>,
      async (_text, info) => {
        if (info) infos.push(info);
      }
    );

    const recorded = infos.flatMap(info => info.toolsUsed ?? []).find(t => t.id === TOOL_ID);
    expect(recorded).toMatchObject({ name: 'web_search', success: false });
    expect(recorded?.returnValue).toBe(`Error processing web_search tool: ${TIMEOUT_MESSAGE}`);
  });
});
