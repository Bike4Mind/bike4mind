import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@bike4mind/observability';
import { BaseBedrockBackend } from './base';
import type { ICompletionOptions, ICompletionResponseChunk, IMessage, ModelInfo } from '@bike4mind/common';
import type { CompletionInfo } from '../types';
import { ChatModels } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';
import DeepSeekBedrockBackend from './deepseek';
import LlamaBedrockBackend from './llama';
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
 * stopReason cannot replace the terminal event: message_delta carries Claude's stop reason
 * before message_stop, so a stream ending between them must still trigger the guard.
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
const run = (backend: BaseBedrockBackend, extra: Partial<ICompletionOptions> = {}) =>
  backend.complete(
    TEST_MODEL,
    [{ role: 'user', content: 'hi' }],
    { stream: true, ...extra } as Partial<ICompletionOptions>,
    cb
  );

/** Yields chunks, aborting the controller partway so the stream ends mid-answer like a user Stop. */
const abortingBody = (chunks: unknown[], controller: AbortController, abortAfter: number) => ({
  [Symbol.asyncIterator]: async function* () {
    let i = 0;
    for (const c of chunks) {
      if (i++ === abortAfter) controller.abort();
      yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(c)) } };
    }
  },
});

const textChunk = (text: string, terminal = false) =>
  ({
    terminal,
    choices: [{ index: 0, chunkText: text, usage: { input_tokens: 5, output_tokens: 3 } }],
  }) as unknown as ICompletionResponseChunk;

describe('BaseBedrockBackend truncated-stream guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  // The region asserted here is the constructor default: this double no-ops
  // updateClientForModel to keep the injected client, so it never region-switches. The point
  // is that the message carries the region the backend is actually holding, whatever that is.
  it('names the model, region and how much was lost', async () => {
    const backend = new TerminalSignallingBackend();
    const region = (backend as unknown as { _options: { region: string } })._options.region;
    const err = await run(withBody(backend, streamBody([textChunk('12345')]))).catch((e: Error) => e);

    expect((err as Error).message).toMatch(/test-model/);
    expect((err as Error).message).toContain(region);
    expect((err as Error).message).toMatch(/5 chars/);
  });

  // Nothing produced and no terminal event is a stall before the first token, not a truncation:
  // it is reported as EMPTY, worded so the stream-idle retry path still classifies it.
  it('reports a stall before the first token as an EMPTY response the retry path classifies', async () => {
    const err = await run(withBody(new TerminalSignallingBackend(), streamBody([]))).catch((e: Error) => e);
    const message = (err as Error).message;

    expect(message).toMatch(/EMPTY response/i);
    expect(message).toMatch(/stream timeout/);
    expect(message).not.toContain('without a terminal event');
    expect(message).toContain('If every call on this model is empty');
  });

  /**
   * An empty stream that DID end with a terminal event needs OPPOSITE handling from a stall. It
   * is deterministic (in production it is the max-tool-calls cap path), and retrying it re-runs
   * every tool call only to fail again. Since the retry decision is made by substring match on
   * the message, letting "stream timeout" leak into this wording would silently convert a
   * deterministic failure into an expensive retry loop.
   */
  it('keeps an empty response that ended with a terminal event out of the retry classification', async () => {
    const body = streamBody([{ terminal: true, choices: [] }]);
    const err = await run(withBody(new TerminalSignallingBackend(), body)).catch((e: Error) => e);
    const message = (err as Error).message;

    expect(message).toMatch(/EMPTY response/i);
    expect(message).not.toMatch(/stream timeout/i);
    expect(message).not.toContain('without a terminal event');
    expect(message).toContain('If every call on this model is empty');
  });

  it('keeps a real Anthropic empty message (message_start + message_stop) out of the retry classification', async () => {
    const body = streamBody([
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'message_stop' },
    ]);
    // updateClientForModel swaps _bedrockRuntime per model, so stub the stream call itself.
    const backend = new (class extends AnthropicBedrockBackend {
      protected override async invokeModelStream() {
        return { body };
      }
    })();
    const err = await backend
      .complete(ChatModels.CLAUDE_4_5_SONNET_BEDROCK, [{ role: 'user', content: 'hi' }], { stream: true }, cb)
      .catch((e: Error) => e);
    const message = (err as Error).message;

    expect(message).toMatch(/EMPTY response/i);
    expect(message).not.toMatch(/stream timeout/i);
    expect(message).not.toContain('without a terminal event');
  });

  it('words a real Anthropic stall (message_start, no message_stop) so the retry path classifies it', async () => {
    const body = streamBody([{ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } }]);
    const backend = new (class extends AnthropicBedrockBackend {
      protected override async invokeModelStream() {
        return { body };
      }
    })();
    const err = await backend
      .complete(ChatModels.CLAUDE_4_5_SONNET_BEDROCK, [{ role: 'user', content: 'hi' }], { stream: true }, cb)
      .catch((e: Error) => e);
    const message = (err as Error).message;

    expect(message).toMatch(/stream timeout/);
    expect(message).not.toContain('without a terminal event');
  });

  // The retry and fallback downstream log the failure at WARN, so this backend log is the ERROR
  // signal a persistent misroute (every call empty) still raises.
  it('logs a stalled empty stream at ERROR before it is retried', async () => {
    const error = vi.spyOn(Logger.globalInstance, 'error').mockImplementation(() => {});

    await run(withBody(new TerminalSignallingBackend(), streamBody([]))).catch(() => {});

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][1]).toMatchObject({ message: expect.stringContaining('EMPTY response') });
  });

  it('does not report an aborted empty stream as an EMPTY response', async () => {
    const controller = new AbortController();
    controller.abort();
    const callback = vi.fn(cb);

    await withBody(new TerminalSignallingBackend(), streamBody([])).complete(
      TEST_MODEL,
      [{ role: 'user', content: 'hi' }],
      { stream: true, abortSignal: controller.signal } as Partial<ICompletionOptions>,
      callback
    );

    for (const [text] of callback.mock.calls) expect(text.filter(Boolean)).toEqual([]);
  });

  it('still reports an empty stream when an abortSignal is present but un-aborted', async () => {
    const controller = new AbortController();

    await expect(
      run(withBody(new TerminalSignallingBackend(), streamBody([])), { abortSignal: controller.signal })
    ).rejects.toThrow(/EMPTY response/i);
  });

  /**
   * A user Stop must NOT be reported as a truncation. In the h2 handler the abort callback and
   * the requestTimeout callback do the same two things, and both were verified to end the real
   * event-stream body iterator cleanly with no throw - so a cancel arrives here byte-for-byte
   * like a stall: output emitted, no terminal event.
   *
   * Without the abortSignal check this throws `stream timeout ... TRUNCATED`, which is not an
   * abort error, so it logs at ERROR, escapes logToSlackClassify's skip list, and matches
   * isStreamIdleTimeoutError - discarding the partial reply and re-running a completion the user
   * deliberately stopped. Cancel must keep its pre-existing behaviour: return what arrived.
   */
  it('does not report a user cancellation as a truncated stream', async () => {
    const controller = new AbortController();
    const body = abortingBody([textChunk('partial ans'), textChunk('wer')], controller, 1);

    await expect(
      run(withBody(new TerminalSignallingBackend(), body), { abortSignal: controller.signal })
    ).resolves.not.toThrow();
  });

  it('still throws for a stall when an abortSignal is present but un-aborted', async () => {
    const controller = new AbortController();
    const body = streamBody([textChunk('half an answ')]);

    await expect(
      run(withBody(new TerminalSignallingBackend(), body), { abortSignal: controller.signal })
    ).rejects.toThrow(/TRUNCATED/);
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
   * jurassicTwo is absent for a different reason - it forces stream:false, so the guard's
   * branch is unreachable there and an override would be dead code.
   */
  it.each([
    ['anthropic', AnthropicBedrockBackend, true],
    ['deepseek', DeepSeekBedrockBackend, true],
    ['llama', LlamaBedrockBackend, true],
    ['titan', TitanBedrockBackend, false],
    ['moonshot', MoonshotBedrockBackend, false],
  ])('%s opts into the terminal-event check: %s', (_name, Backend, expected) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instance = new (Backend as any)();
    expect((instance as { signalsStreamTermination: boolean }).signalsStreamTermination).toBe(expected);
  });
});
