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

  it('never falls back from a model on a saved model server to a hosted one', async () => {
    const inner = createMockBackend({ failWith: new Error('vllm could not be reached') });
    const fallback = new FallbackLlmBackend(inner, ['claude-sonnet'], onFallback);

    await expect(
      fallback.complete('local:srv-vllm01:qwen-small', makeMessages(), makeOptions(), callback)
    ).rejects.toThrow('vllm could not be reached');
    expect(inner.complete).toHaveBeenCalledOnce();
    expect(onFallback).not.toHaveBeenCalled();
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

  it('falls back when an attempt fails before delivering any output', async () => {
    const inner = createMockBackend();
    (inner.complete as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockImplementationOnce(async (_model, _msgs, _opts, cb) => {
        await cb(['final from model-b'], {});
      });

    const fallback = new FallbackLlmBackend(inner, ['model-b'], onFallback);
    await fallback.complete('model-a', makeMessages(), makeOptions(), callback);

    expect(onFallback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(['final from model-b'], {});
  });

  it('streams output live and does not fall back once output was delivered (no double-content)', async () => {
    // The caller appends every delivery, so falling back after one would put the
    // next model's answer on top of the partial one. The failure surfaces instead.
    const error = new Error('stream broke');
    const inner = createMockBackend();
    (inner.complete as ReturnType<typeof vi.fn>).mockImplementation(async (_model, _msgs, _opts, cb) => {
      await cb(['partial from model-a']);
      expect(callback).toHaveBeenCalledWith(['partial from model-a'], undefined);
      throw error;
    });

    const fallback = new FallbackLlmBackend(inner, ['model-b'], onFallback);
    await expect(fallback.complete('model-a', makeMessages(), makeOptions(), callback)).rejects.toThrow(error);

    expect(inner.complete).toHaveBeenCalledOnce();
    expect(onFallback).not.toHaveBeenCalled();
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

  describe('a refusal settled by the server', () => {
    // The final frame of a declined turn: whatever text it carries, plus stopReason 'refusal'.
    const refusingThen = (inner: ICompletionBackend, answer: (model: string) => boolean) =>
      (inner.complete as ReturnType<typeof vi.fn>).mockImplementation(async (model, _msgs, _opts, cb) => {
        if (answer(model)) await cb(['answer'], { stopReason: 'end_turn' });
        else await cb(['partial'], { stopReason: 'refusal' });
      });

    it('falls back to the next model without delivering the refused turn', async () => {
      const inner = createMockBackend();
      refusingThen(inner, model => model === 'model-b');
      const fallback = new FallbackLlmBackend(inner, ['model-b'], onFallback);

      await fallback.complete('model-a', makeMessages(), makeOptions(), callback);

      expect(inner.complete).toHaveBeenCalledTimes(2);
      expect(onFallback).toHaveBeenCalledWith(
        'model-a',
        'model-b',
        expect.objectContaining({ kind: 'refused', message: 'The model declined this request' })
      );
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(['answer'], { stopReason: 'end_turn' });
    });

    it('delivers the last model refusal to the caller', async () => {
      const inner = createMockBackend();
      refusingThen(inner, () => false);
      const fallback = new FallbackLlmBackend(inner, ['model-b'], onFallback);

      await fallback.complete('model-a', makeMessages(), makeOptions(), callback);

      expect(inner.complete).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(['partial'], { stopReason: 'refusal' });
    });

    it('includes charged refusals in the fallback model cumulative accounting', async () => {
      const inner = createMockBackend();
      const refusedUsage: CompletionInfo = {
        inputTokens: 10,
        outputTokens: 2,
        reasoningTokens: 1,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 6,
        cacheWrite1hInputTokens: 3,
        creditsUsed: 3,
        usdCost: 0.03,
      };
      (inner.complete as ReturnType<typeof vi.fn>).mockImplementation(async (model, _msgs, _opts, cb) => {
        if (model === 'model-a') {
          await cb(['refused text'], { ...refusedUsage, stopReason: 'refusal' });
          // Settlement follows the refusal frame, carrying the same cumulative totals.
          await cb([], { ...refusedUsage, creditsUsed: 3 });
          return;
        }
        await cb(['answer'], { inputTokens: 20, outputTokens: 1 });
        await cb([' continued'], {
          inputTokens: 20,
          outputTokens: 5,
          reasoningTokens: 2,
          cacheReadInputTokens: 7,
          cacheCreationInputTokens: 8,
          cacheWrite1hInputTokens: 4,
          creditsUsed: 2,
          usdCost: 0.02,
          stopReason: 'end_turn',
        });
      });
      const fallback = new FallbackLlmBackend(inner, ['model-b'], onFallback);

      await fallback.complete('model-a', makeMessages(), makeOptions(), callback);

      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenNthCalledWith(
        1,
        ['answer'],
        expect.objectContaining({ inputTokens: 30, outputTokens: 3, creditsUsed: 3 })
      );
      expect(callback).toHaveBeenLastCalledWith([' continued'], {
        inputTokens: 30,
        outputTokens: 7,
        reasoningTokens: 3,
        cacheReadInputTokens: 11,
        cacheCreationInputTokens: 14,
        cacheWrite1hInputTokens: 7,
        creditsUsed: 5,
        usdCost: 0.05,
        stopReason: 'end_turn',
      });
    });

    it('includes each refused model once when the final model also refuses', async () => {
      const inner = createMockBackend();
      (inner.complete as ReturnType<typeof vi.fn>).mockImplementation(async (model, _msgs, _opts, cb) => {
        await cb([''], { creditsUsed: model === 'model-a' ? 3 : 2, stopReason: 'refusal' });
      });
      const fallback = new FallbackLlmBackend(inner, ['model-b', 'model-c'], onFallback);

      await fallback.complete('model-a', makeMessages(), makeOptions(), callback);

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith([''], { creditsUsed: 7, stopReason: 'refusal' });
    });

    it('does not fall back once text already reached the caller', async () => {
      const inner = createMockBackend();
      (inner.complete as ReturnType<typeof vi.fn>).mockImplementation(async (_model, _msgs, _opts, cb) => {
        await cb(['streamed ']);
        await cb([''], { stopReason: 'refusal' });
      });
      const fallback = new FallbackLlmBackend(inner, ['model-b'], onFallback);

      await fallback.complete('model-a', makeMessages(), makeOptions(), callback);

      expect(inner.complete).toHaveBeenCalledOnce();
      expect(onFallback).not.toHaveBeenCalled();
      expect(callback).toHaveBeenLastCalledWith([''], { stopReason: 'refusal' });
    });
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
