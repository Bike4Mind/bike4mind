/**
 * A model whose thinking display is omitted streams a thinking block carrying only a
 * signature. Opening the marker on the block start persisted a bare `<think></think>` reply
 * slot on every such turn, so the adapters must stay silent until reasoning text arrives.
 */

import { describe, it, expect } from 'vitest';
import { ModelBackend, type CompletionInfo, type IMessage, type ModelInfo } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import AnthropicBedrockBackend from './bedrockBackend/anthropic';
import { closeThinkMarker } from './thinkMarkers';
import type { ICompletionOptions } from './backend';

const PROSE = 'It is sunny in Paris.';

function events(thinkingDeltas: string[]): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 40 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    ...thinkingDeltas.map(thinking => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking },
    })),
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-payload' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: PROSE } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 90 } },
    { type: 'message_stop' },
  ];
}

function capture() {
  const chunks: string[] = [];
  return {
    chunks,
    cb: async (text: (string | null | undefined)[], _info?: CompletionInfo) => {
      chunks.push(text.filter((t): t is string => typeof t === 'string').join(''));
    },
  };
}

async function runDirect(stream: unknown[]): Promise<string> {
  const backend = new AnthropicBackend('test-key');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK client has no exported mock shape
  (backend as unknown as { _api: any })._api = {
    messages: {
      create: async () => ({
        [Symbol.asyncIterator]: async function* () {
          for (const e of stream) yield e;
        },
        controller: { abort: () => {} },
      }),
    },
  };
  const { chunks, cb } = capture();
  await backend.complete(
    'claude-opus-4-5',
    [{ role: 'user', content: 'weather in Paris?' }],
    { stream: true, tools: [] },
    cb
  );
  return chunks.join('');
}

const MODEL = 'us.anthropic.claude-opus-5';
const modelRecord = {
  id: MODEL,
  type: 'text',
  name: 'Claude Opus 5 (Bedrock)',
  backend: ModelBackend.Bedrock,
  contextWindow: 200000,
  supportsImageVariation: false,
  max_tokens: 64000,
  can_stream: true,
  can_think: true,
  thinkingStyle: 'adaptive',
  pricing: { 200000: { input: 0.000005, output: 0.000025 } },
} as ModelInfo;

class StubbedBedrockBackend extends AnthropicBedrockBackend {
  constructor(private readonly events: unknown[]) {
    super();
  }

  protected override updateClientForModel(_model: string): void {
    // intentionally empty - no real client is needed
  }

  protected override async invokeModelStream(): Promise<{
    body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>;
  }> {
    const events = this.events;
    return {
      body: {
        [Symbol.asyncIterator]: async function* () {
          for (const chunk of events) {
            yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(chunk)) } };
          }
        },
      },
    };
  }
}

async function runBedrock(stream: unknown[]): Promise<string> {
  const backend = new StubbedBedrockBackend(stream);
  backend.setDispatchModel(modelRecord);
  const { chunks, cb } = capture();
  const messages: IMessage[] = [{ role: 'user', content: 'weather in Paris?' }];
  await backend.complete(MODEL, messages, { stream: true, maxTokens: 64000 } as Partial<ICompletionOptions>, cb);
  return chunks.join('');
}

describe.each([
  ['AnthropicBackend', runDirect],
  ['AnthropicBedrockBackend', runBedrock],
])('%s with a thinking block that streams no reasoning', (_name, run) => {
  it('emits no think markers', async () => {
    expect(await run(events([]))).toBe(PROSE);
  });

  it('emits no think markers for empty thinking deltas', async () => {
    expect(await run(events(['', '']))).toBe(PROSE);
  });

  it('still wraps reasoning that does stream', async () => {
    expect(await run(events(['Short ', 'thought.']))).toBe(`<think>Short thought.</think>${PROSE}`);
  });

  it('opens the marker for reasoning the escaper held until the block closed', async () => {
    // '<th' could be the start of a literal marker, so the escaper holds it until flush.
    expect(await run(events(['<th']))).toBe(`<think><th</think>${PROSE}`);
  });

  it('does not close a markerless block after one that streamed reasoning', async () => {
    const stream = events(['Short.']);
    const emptyBlock = [
      { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature: 'sig-2' } },
      { type: 'content_block_stop', index: 2 },
    ];
    // The second thinking block lands between the prose and message_delta.
    expect(await run([...stream.slice(0, -2), ...emptyBlock, ...stream.slice(-2)])).toBe(
      `<think>Short.</think>${PROSE}`
    );
  });
});

describe('closeThinkMarker', () => {
  it('returns nothing for a block that never produced reasoning', () => {
    expect(closeThinkMarker('', false)).toBe('');
  });

  it('closes an opened block', () => {
    expect(closeThinkMarker('', true)).toBe('</think>');
    expect(closeThinkMarker('tail', true)).toBe('tail</think>');
  });

  it('wraps reasoning released only at close', () => {
    expect(closeThinkMarker('tail', false)).toBe('<think>tail</think>');
  });
});
