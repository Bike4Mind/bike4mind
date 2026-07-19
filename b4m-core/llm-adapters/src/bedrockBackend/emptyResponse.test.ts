import { describe, it, expect } from 'vitest';
import { BaseBedrockBackend } from './base';
import type { ICompletionOptions, ICompletionResponseChunk, IMessage, ModelInfo } from '@bike4mind/common';
import type { CompletionInfo } from '../types';
import { ChatModels } from '@bike4mind/common';

/**
 * The fail-loud guard for empty Bedrock completions.
 *
 * A "global." cross-region inference profile invoked from a region that does not host it comes back as
 * an EMPTY stream - no chunks, no error. The backend used to return silently, so the chat had nothing to
 * render and hung until the client timed out (~2 minutes) with no diagnostic. This proves the backend
 * now throws a clear, actionable error instead - and that a normal streamed completion is unaffected.
 */

const TEST_MODEL = 'test-model' as ChatModels;

class TestBedrockBackend extends BaseBedrockBackend {
  protected override updateClientForModel(): void {
    // keep the test-injected _bedrockRuntime mock
  }
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

/** A Bedrock response body that yields the given chunk objects (empty array = the empty-stream case). */
const streamBody = (chunks: unknown[]) => ({
  [Symbol.asyncIterator]: async function* () {
    for (const c of chunks) yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(c)) } };
  },
});

const withBody = (body: unknown): TestBedrockBackend => {
  const backend = new TestBedrockBackend();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = { send: async () => ({ body }) };
  return backend;
};

const cb = async (_text: (string | null | undefined)[], _info?: CompletionInfo) => {};
const run = (backend: TestBedrockBackend) =>
  backend.complete(TEST_MODEL, [{ role: 'user', content: 'hi' }], { stream: true } as Partial<ICompletionOptions>, cb);

const textChunk = (text: string): ICompletionResponseChunk =>
  ({
    choices: [{ index: 0, chunkText: text, usage: { input_tokens: 5, output_tokens: 3 } }],
  }) as unknown as ICompletionResponseChunk;

describe('BaseBedrockBackend empty-response guard', () => {
  it('throws a clear error when the stream yields no content (the global-profile hang)', async () => {
    await expect(run(withBody(streamBody([])))).rejects.toThrow(/EMPTY response/i);
  });

  it('names the model and region so the fix is obvious from the message', async () => {
    await expect(run(withBody(streamBody([])))).rejects.toThrow(/test-model/);
    await expect(run(withBody(streamBody([])))).rejects.toThrow(/us-east-2/); // default region
  });

  it('does NOT throw when the stream produces real text', async () => {
    await expect(run(withBody(streamBody([textChunk('hello there')])))).resolves.not.toThrow();
  });

  it('does NOT throw on a whitespace-only-but-nonempty completion', async () => {
    // A single space is real output the pipeline can render - only truly zero content is an error.
    await expect(run(withBody(streamBody([textChunk(' ')])))).resolves.not.toThrow();
  });
});
