/**
 * BaseBedrockBackend forwards a translate()-reported stopReason onto CompletionInfo.
 *
 * ChatCompletionProcess turns `stopReason === 'max_tokens'` into the truncation
 * notice on the reply. Bedrock needs its own harness (BedrockRuntimeClient plus a
 * per-subclass translate) rather than a row in stopReasonBackends.test.ts, so the
 * test backend here passes pre-shaped ICompletionResponseChunk objects through.
 */

import { describe, it, expect } from 'vitest';
import type { IMessage, ModelInfo } from '@bike4mind/common';
import { BaseBedrockBackend } from './base';
import {
  ChoiceEndReason,
  ChoiceStatus,
  type CompletionInfo,
  type IChoiceEndToolUse,
  type ICompletionResponseChunk,
} from '../backend';

class TestBedrockBackend extends BaseBedrockBackend {
  // updateClientForModel rebuilds the AWS client at the top of every complete(),
  // which would clobber the mock injected via _bedrockRuntime.
  protected override updateClientForModel(_model: string): void {
    // intentionally empty
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

  pushToolMessages(_messages: IMessage[], _tool: IChoiceEndToolUse['tool'], _result: string): void {
    // unused: no tool round-trips here
  }
}

const messages: IMessage[] = [{ role: 'user', content: 'hi' } as IMessage];

const endChoice = (chunkText: string) => ({
  status: ChoiceStatus.END,
  statusEndReason: ChoiceEndReason.STOP,
  index: 0,
  chunkText,
  usage: { input_tokens: 10, output_tokens: 20 },
});

/** Mocks the streaming transport: each chunk is JSON-encoded into `bytes`. */
function streamingBackend(chunks: unknown[]): TestBedrockBackend {
  const backend = new TestBedrockBackend();
  (backend as unknown as { _bedrockRuntime: { send: (c: unknown) => Promise<unknown> } })._bedrockRuntime = {
    send: async () => ({
      body: {
        [Symbol.asyncIterator]: async function* () {
          for (const c of chunks) yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(c)) } };
        },
      },
    }),
  };
  return backend;
}

/** Mocks the InvokeModel transport, whose whole response body is one JSON blob. */
function nonStreamingBackend(response: unknown): TestBedrockBackend {
  const backend = new TestBedrockBackend();
  (backend as unknown as { _bedrockRuntime: { send: (c: unknown) => Promise<unknown> } })._bedrockRuntime = {
    send: async () => ({ body: new TextEncoder().encode(JSON.stringify(response)) }),
  };
  return backend;
}

async function lastInfo(backend: TestBedrockBackend, stream: boolean): Promise<CompletionInfo | undefined> {
  const infos: (CompletionInfo | undefined)[] = [];
  await backend.complete('test', messages, { stream }, async (_text, info) => {
    infos.push(info);
  });
  return infos[infos.length - 1];
}

describe('BaseBedrockBackend surfaces stopReason on CompletionInfo', () => {
  it('carries a truncated streaming turn through as max_tokens', async () => {
    const backend = streamingBackend([
      { model: 'test', choices: [endChoice('partial ')] },
      { model: 'test', choices: [endChoice('answer')], stopReason: 'max_tokens' },
    ]);
    expect((await lastInfo(backend, true))?.stopReason).toBe('max_tokens');
  });

  it('carries a clean streaming turn through as stop', async () => {
    const backend = streamingBackend([{ model: 'test', choices: [endChoice('answer')], stopReason: 'stop' }]);
    expect((await lastInfo(backend, true))?.stopReason).toBe('stop');
  });

  it('carries a truncated non-streaming turn through as max_tokens', async () => {
    const backend = nonStreamingBackend({ model: 'test', choices: [endChoice('cut off')], stopReason: 'max_tokens' });
    expect((await lastInfo(backend, false))?.stopReason).toBe('max_tokens');
  });

  it('omits stopReason for an adapter whose translate reports none', async () => {
    const backend = streamingBackend([{ model: 'test', choices: [endChoice('answer')] }]);
    expect((await lastInfo(backend, true))?.stopReason).toBeUndefined();
  });
});
