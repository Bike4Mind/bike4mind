import { describe, it, expect } from 'vitest';
import { BaseBedrockBackend } from './base';
import type { ICompletionOptions, ICompletionResponseChunk, IMessage, ModelInfo } from '@bike4mind/common';
import type { CompletionInfo } from '../types';
import { ChatModels } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';
import DeepSeekBedrockBackend from './deepseek';
import LlamaBedrockBackend from './llama';
import JurassicTwoBedrockBackend from './jurassicTwo';
import TitanBedrockBackend from './titan';
import MoonshotBedrockBackend from './moonshot';

/**
 * The fail-loud guard for TRUNCATED Bedrock completions.
 *
 * A transport stall part-way through a response closes the h2 stream gracefully
 * (NGHTTP2_NO_ERROR), so the stream loop simply ends: send() has already resolved, nothing
 * rejects, and the empty-response guard passes because text WAS produced. Before this guard a
 * half-finished answer was delivered as a complete one - no error, no retry, nothing greppable.
 *
 * The signal is the adapter's terminal event (`done`), which base.ts previously discarded.
 * stopReason cannot be used: it is absent on healthy turns for every adapter except deepseek and
 * moonshot, so keying on it would throw on healthy Claude traffic.
 *
 * @see BaseBedrockBackend.signalsStreamTermination
 */

const TEST_MODEL = 'test-model' as ChatModels;

/** Reports `done` only on a chunk carrying `terminal: true`, like a real terminal-event adapter. */
class TerminalSignallingBackend extends BaseBedrockBackend {
  protected override get signalsStreamTermination(): boolean {
    return true;
  }
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
    const raw = json as { terminal?: boolean };
    return { done: raw.terminal === true, chunk: json as ICompletionResponseChunk };
  }
  translateChunk(_model: string, json: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: true, chunk: json as ICompletionResponseChunk };
  }
  pushToolMessages(): void {}
}

/** Same, but has not opted in - the pre-existing behaviour every other adapter and test double keeps. */
class NonSignallingBackend extends TerminalSignallingBackend {
  protected override get signalsStreamTermination(): boolean {
    return false;
  }
}

const streamBody = (chunks: unknown[]) => ({
  [Symbol.asyncIterator]: async function* () {
    for (const c of chunks) yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(c)) } };
  },
});

const withBody = <T extends BaseBedrockBackend>(backend: T, body: unknown): T => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = { send: async () => ({ body }) };
  return backend;
};

const cb = async (_text: (string | null | undefined)[], _info?: CompletionInfo) => {};
const run = (backend: BaseBedrockBackend) =>
  backend.complete(TEST_MODEL, [{ role: 'user', content: 'hi' }], { stream: true } as Partial<ICompletionOptions>, cb);

const textChunk = (text: string, terminal = false) =>
  ({
    terminal,
    choices: [{ index: 0, chunkText: text, usage: { input_tokens: 5, output_tokens: 3 } }],
  }) as unknown as ICompletionResponseChunk;

describe('BaseBedrockBackend truncated-stream guard', () => {
  it('throws when text was produced but no terminal event ever arrived', async () => {
    const body = streamBody([textChunk('half an answ')]);
    await expect(run(withBody(new TerminalSignallingBackend(), body))).rejects.toThrow(/TRUNCATED/);
  });

  it('does NOT throw when the terminal event arrives', async () => {
    const body = streamBody([textChunk('half an answ'), textChunk('er, complete', true)]);
    await expect(run(withBody(new TerminalSignallingBackend(), body))).resolves.not.toThrow();
  });

  it('accepts a terminal event on any chunk, not only the last', async () => {
    const body = streamBody([textChunk('done early', true), textChunk(' plus trailing usage')]);
    await expect(run(withBody(new TerminalSignallingBackend(), body))).resolves.not.toThrow();
  });

  /**
   * The substring is load-bearing, not cosmetic: ChatCompletionProcess's isStreamIdleTimeoutError
   * matches on it, which is what buys the retry-once-then-fallback path and a WARN-severity log
   * instead of a false ERROR page. It cannot be asserted by importing that helper (services
   * depends on llm-adapters, not the reverse), so it is pinned here.
   */
  it('is worded so the existing stream-idle retry path classifies it', async () => {
    const body = streamBody([textChunk('half an answ')]);
    await expect(run(withBody(new TerminalSignallingBackend(), body))).rejects.toThrow(/stream timeout/);
  });

  it('names the model, region and how much was lost', async () => {
    const body = streamBody([textChunk('12345')]);
    const err = await run(withBody(new TerminalSignallingBackend(), body)).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/test-model/);
    expect((err as Error).message).toMatch(/us-east-2/);
    expect((err as Error).message).toMatch(/5 chars/);
  });

  // The empty-stream case has its own, more actionable message (misrouted inference profile), so
  // it must win rather than being reported as a truncation.
  it('defers to the empty-response guard when nothing was produced at all', async () => {
    const body = streamBody([]);
    await expect(run(withBody(new TerminalSignallingBackend(), body))).rejects.toThrow(/EMPTY response/i);
  });

  /**
   * The two post-loop guards need OPPOSITE handling, so their messages must stay textually
   * distinguishable. A truncation is a transient transport failure and retry-once is right; an
   * empty response is deterministic (in production it is the max-tool-calls cap path), and
   * retrying it re-runs every tool call only to fail again. Since the retry decision is made by
   * substring match on the message, letting "stream timeout" leak into the empty-response
   * wording would silently convert a deterministic failure into an expensive retry loop.
   */
  it('keeps the empty-response message out of the stream-idle retry classification', async () => {
    const err = await run(withBody(new TerminalSignallingBackend(), streamBody([]))).catch((e: Error) => e);
    const message = (err as Error).message;

    expect(message).toMatch(/EMPTY response/i);
    expect(message).not.toMatch(/stream timeout/i);
  });

  // Opt-in means silence keeps the old behaviour: adapters that never report done - titan and
  // moonshot report it on every chunk, the test doubles never - must be unaffected.
  it('leaves a backend that has not opted in untouched', async () => {
    const body = streamBody([textChunk('half an answ')]);
    await expect(run(withBody(new NonSignallingBackend(), body))).resolves.not.toThrow();
  });

  /**
   * Pins which adapters carry the protection. Losing an override would silently disarm the guard
   * for that model - the exact class of failure this whole area exists to prevent - and no other
   * test would notice, because a disarmed guard just stops throwing.
   *
   * titan and moonshot are deliberately absent: they report `done: true` on every content chunk,
   * so opting them in would be inert. Tightening them means a stopReason passthrough instead.
   */
  it.each([
    ['anthropic', AnthropicBedrockBackend, true],
    ['deepseek', DeepSeekBedrockBackend, true],
    ['llama', LlamaBedrockBackend, true],
    ['jurassicTwo', JurassicTwoBedrockBackend, true],
    ['titan', TitanBedrockBackend, false],
    ['moonshot', MoonshotBedrockBackend, false],
  ])('%s opts into the terminal-event check: %s', (_name, Backend, expected) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instance = new (Backend as any)();
    expect((instance as { signalsStreamTermination: boolean }).signalsStreamTermination).toBe(expected);
  });
});
