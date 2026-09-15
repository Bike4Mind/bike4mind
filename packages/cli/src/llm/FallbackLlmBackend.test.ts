import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FallbackLlmBackend } from './FallbackLlmBackend';
import type { ICompletionBackend, ICompletionOptions, CompletionInfo } from '@bike4mind/llm-adapters';
import type { IMessage, ModelInfo } from '@bike4mind/common';

// Minimal mock backend
function createMockBackend(
  options: {
    failWith?: Error;
    onComplete?: (model: string) => void;
  } = {}
): ICompletionBackend {
  return {
    currentModel: '',
    complete: vi.fn(async (model, _messages, _options, callback) => {
      options.onComplete?.(model);
      if (options.failWith) {
        throw options.failWith;
      }
      await callback(['result'], {});
    }),
    pushToolMessages: vi.fn(),
    getModelInfo: vi.fn().mockResolvedValue([] as ModelInfo[]),
  };
}

function makeMessages(): IMessage[] {
  return [{ role: 'user', content: 'hello' }];
}

function makeOptions(overrides: Partial<ICompletionOptions> = {}): Partial<ICompletionOptions> {
  return { tools: [], ...overrides };
}

describe('FallbackLlmBackend', () => {
  let onFallback: ReturnType<typeof vi.fn<(fromModel: string, toModel: string, error: Error) => void>>;
  let callback: ReturnType<
    typeof vi.fn<(text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>>
  >;

  beforeEach(() => {
    onFallback = vi.fn<(fromModel: string, toModel: string, error: Error) => void>();
    callback = vi
      .fn<(text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>>()
      .mockResolvedValue(undefined);
  });

  it('succeeds on first model — onFallback never called', async () => {
    const inner = createMockBackend();
    const fallback = new FallbackLlmBackend(inner, ['model-b'], onFallback);

    await fallback.complete('model-a', makeMessages(), makeOptions(), callback);

    expect(inner.complete).toHaveBeenCalledOnce();
    expect(inner.complete).toHaveBeenCalledWith('model-a', expect.anything(), expect.anything(), expect.any(Function));
    expect(onFallback).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('falls back to next model when primary fails', async () => {
    const error = new Error('rate limit exceeded');
    const modelsAttempted: string[] = [];
    const inner = createMockBackend({
      failWith: error,
      onComplete: model => modelsAttempted.push(model),
    });

    // Override: succeed on second call
    let callCount = 0;
    (inner.complete as ReturnType<typeof vi.fn>).mockImplementation(async (model, _msgs, _opts, cb) => {
      modelsAttempted.push(model);
      callCount++;
      if (callCount === 1) throw error;
      await cb(['result'], {});
    });

    const fallback = new FallbackLlmBackend(inner, ['model-b', 'model-c'], onFallback);
    await fallback.complete('model-a', makeMessages(), makeOptions(), callback);

    expect(modelsAttempted).toEqual(['model-a', 'model-b']);
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith('model-a', 'model-b', error);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('throws when all models are exhausted', async () => {
    const error = new Error('unavailable');
    const inner = createMockBackend({ failWith: error });

    const fallback = new FallbackLlmBackend(inner, ['model-b'], onFallback);
    await expect(fallback.complete('model-a', makeMessages(), makeOptions(), callback)).rejects.toThrow('unavailable');

    expect(inner.complete).toHaveBeenCalledTimes(2);
    expect(callback).not.toHaveBeenCalled();
  });

  it('skips duplicate models in fallback chain', async () => {
    const modelsAttempted: string[] = [];
    const error = new Error('fail');
    let calls = 0;
    const inner = createMockBackend();

    (inner.complete as ReturnType<typeof vi.fn>).mockImplementation(async (model, _msgs, _opts, cb) => {
      modelsAttempted.push(model);
      calls++;
      if (calls < 3) throw error;
      await cb(['ok'], {});
    });

    // model-a appears in the fallback list - should be deduplicated
    const fallback = new FallbackLlmBackend(inner, ['model-a', 'model-b', 'model-c'], onFallback);
    await fallback.complete('model-a', makeMessages(), makeOptions(), callback);

    // model-a tried once (not twice), then model-b, then model-c succeeds
    expect(modelsAttempted).toEqual(['model-a', 'model-b', 'model-c']);
  });

  it('propagates abort signal immediately — skips fallback loop entirely', async () => {
    const controller = new AbortController();
    controller.abort();

    // Inner returns gracefully for an already-aborted signal (real backends do this)
    const inner = createMockBackend(); // succeeds (real abort handling is inside the backend)
    const fallback = new FallbackLlmBackend(inner, ['model-b'], onFallback);

    await fallback.complete('model-a', makeMessages(), makeOptions({ abortSignal: controller.signal }), callback);

    // Passed straight through to inner - no fallback loop, no onFallback
    expect(inner.complete).toHaveBeenCalledOnce();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('stops fallback loop when abort signal fires mid-retry', async () => {
    const controller = new AbortController();
    const error = new Error('rate limit');
    let calls = 0;
    const inner = createMockBackend();

    (inner.complete as ReturnType<typeof vi.fn>).mockImplementation(async (_model, _msgs, opts, cb) => {
      calls++;
      if (calls === 1) {
        // Abort after first failure so second attempt sees aborted signal
        controller.abort();
        throw error;
      }
      await cb(['ok'], {});
    });

    const fallback = new FallbackLlmBackend(inner, ['model-b'], onFallback);
    await expect(
      fallback.complete('model-a', makeMessages(), makeOptions({ abortSignal: controller.signal }), callback)
    ).rejects.toThrow(error);

    // Only tried once - second attempt aborted
    expect(inner.complete).toHaveBeenCalledOnce();
  });

  it('discards a failed attempt’s partial output and falls back cleanly (no double-content)', async () => {
    // OllamaBackend fires the callback per-chunk, so an attempt can stream
    // partial output before throwing. The decorator buffers inner deliveries
    // and only flushes on success, so that partial output must be discarded and
    // never replayed on top of the fallback model's result.
    const error = new Error('stream broke');
    const modelsAttempted: string[] = [];
    let calls = 0;
    const inner = createMockBackend();
    (inner.complete as ReturnType<typeof vi.fn>).mockImplementation(async (model, _msgs, _opts, cb) => {
      modelsAttempted.push(model);
      calls++;
      if (calls === 1) {
        await cb(['partial from model-a'], {}); // streamed, then fails
        throw error;
      }
      await cb(['final from model-b'], {});
    });

    const fallback = new FallbackLlmBackend(inner, ['model-b'], onFallback);
    await fallback.complete('model-a', makeMessages(), makeOptions(), callback);

    expect(modelsAttempted).toEqual(['model-a', 'model-b']);
    expect(onFallback).toHaveBeenCalledOnce();
    // Only the successful model's output reaches the caller, exactly once -
    // the failed attempt's partial chunk is never delivered.
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(['final from model-b'], {});
  });

  it('never delivers buffered output when every model fails after streaming', async () => {
    const error = new Error('all broke');
    const inner = createMockBackend();
    (inner.complete as ReturnType<typeof vi.fn>).mockImplementation(async (_model, _msgs, _opts, cb) => {
      await cb(['partial'], {}); // streams before failing on every attempt
      throw error;
    });

    const fallback = new FallbackLlmBackend(inner, ['model-b'], onFallback);
    await expect(fallback.complete('model-a', makeMessages(), makeOptions(), callback)).rejects.toThrow(error);

    expect(inner.complete).toHaveBeenCalledTimes(2);
    // Buffered partial output is discarded on failure - caller sees nothing.
    expect(callback).not.toHaveBeenCalled();
  });

  it('delegates pushToolMessages and getModelInfo to inner backend', async () => {
    const inner = createMockBackend();
    (inner.getModelInfo as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'model-a', name: 'Model A' }]);
    const fallback = new FallbackLlmBackend(inner, [], onFallback);

    const messages: IMessage[] = [];
    const tool = { name: 'tool', id: 'id-1', parameters: '{}' };
    fallback.pushToolMessages(messages, tool, 'result');
    expect(inner.pushToolMessages).toHaveBeenCalledWith(messages, tool, 'result', undefined);

    const models = await fallback.getModelInfo();
    expect(models).toEqual([{ id: 'model-a', name: 'Model A' }]);
  });

  it('proxies currentModel get/set to inner backend', () => {
    const inner = createMockBackend();
    inner.currentModel = 'initial';
    const fallback = new FallbackLlmBackend(inner, [], onFallback);

    expect(fallback.currentModel).toBe('initial');
    fallback.currentModel = 'updated';
    expect(inner.currentModel).toBe('updated');
  });
});
