/**
 * BaseBedrockBackend forwards a translate()-reported stopReason onto CompletionInfo.
 *
 * ChatCompletionProcess turns `stopReason === 'max_tokens'` into the truncation
 * notice on the reply. Bedrock needs its own harness (BedrockRuntimeClient plus a
 * per-subclass translate) rather than a row in stopReasonBackends.test.ts, so the
 * test backend here passes pre-shaped ICompletionResponseChunk objects through.
 * The real Anthropic adapter is also exercised on both transports below.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type IMessage, type ModelInfo } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';
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

type Runtime = { _bedrockRuntime: { send: (c: unknown) => Promise<unknown> } };

function useTransport<T extends BaseBedrockBackend>(backend: T, transport: Runtime['_bedrockRuntime']): T {
  (backend as unknown as Runtime)._bedrockRuntime = transport;
  return backend;
}

/** A streaming transport: each chunk is JSON-encoded into `bytes`. */
const streamTransport = (chunks: unknown[]): Runtime['_bedrockRuntime'] => ({
  send: async () => ({
    body: {
      [Symbol.asyncIterator]: async function* () {
        for (const c of chunks) yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(c)) } };
      },
    },
  }),
});

/** An InvokeModel transport, whose whole response body is one JSON blob. */
const invokeTransport = (response: unknown): Runtime['_bedrockRuntime'] => ({
  send: async () => ({ body: new TextEncoder().encode(JSON.stringify(response)) }),
});

const streamingBackend = (chunks: unknown[]): TestBedrockBackend =>
  useTransport(new TestBedrockBackend(), streamTransport(chunks));

const nonStreamingBackend = (response: unknown): TestBedrockBackend =>
  useTransport(new TestBedrockBackend(), invokeTransport(response));

async function lastInfo(
  backend: BaseBedrockBackend,
  stream: boolean,
  model = 'test'
): Promise<CompletionInfo | undefined> {
  const infos: (CompletionInfo | undefined)[] = [];
  await backend.complete(model, messages, { stream }, async (_text, info) => {
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

const MODEL = ChatModels.CLAUDE_5_OPUS_BEDROCK;

class AnthropicTestBackend extends AnthropicBedrockBackend {
  // Same reason as TestBedrockBackend: complete() rebuilds the client and would clobber the mock.
  protected override updateClientForModel(_model: string): void {
    // intentionally empty
  }
}

/** The real Claude stream framing, carrying whatever terminal stop_reason the provider reports. */
function anthropicStream(stopReason?: string) {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial answer' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: stopReason ? { stop_reason: stopReason } : {}, usage: { output_tokens: 4096 } },
    { type: 'message_stop' },
  ];
}

describe('AnthropicBedrockBackend surfaces stopReason through complete()', () => {
  it('carries a truncated stream through as max_tokens', async () => {
    const backend = useTransport(new AnthropicTestBackend(), streamTransport(anthropicStream('max_tokens')));
    expect((await lastInfo(backend, true, MODEL))?.stopReason).toBe('max_tokens');
  });

  it('carries a clean stream through as end_turn', async () => {
    const backend = useTransport(new AnthropicTestBackend(), streamTransport(anthropicStream('end_turn')));
    expect((await lastInfo(backend, true, MODEL))?.stopReason).toBe('end_turn');
  });

  it.each(['max_tokens', 'end_turn'])('rejects a %s stream missing message_stop', async stopReason => {
    const chunks = anthropicStream(stopReason).slice(0, -1);
    const backend = useTransport(new AnthropicTestBackend(), streamTransport(chunks));

    await expect(lastInfo(backend, true, MODEL)).rejects.toThrow(/without a terminal event/);
  });

  it('carries a truncated non-streaming turn through as max_tokens', async () => {
    const backend = useTransport(
      new AnthropicTestBackend(),
      invokeTransport({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text: 'cut off' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 12, output_tokens: 4096 },
      })
    );
    expect((await lastInfo(backend, false, MODEL))?.stopReason).toBe('max_tokens');
  });
});
