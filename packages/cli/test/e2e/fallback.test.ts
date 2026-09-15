/**
 * E2E test: FallbackLlmBackend wraps the agent's LLM and switches models on error.
 *
 * Covers the FallbackLlmBackend stack, including the partial-output path the old
 * "callback already fired" guard protected: an inner backend that streams a
 * partial chunk and then throws. Since the streaming event protocol was unified,
 * the decorator buffers inner deliveries and flushes only on success,
 * so a failed attempt's partial output is discarded and a retry can never
 * double-fire - making that guard unnecessary by construction.
 *
 * Note: we test FallbackLlmBackend directly here rather than through
 * runAgent, because runAgent constructs ReActAgent with a single backend.
 * Building the wrapping in-line keeps the test focused on the fallback
 * behavior itself.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ICompletionBackend, ICompletionOptions, CompletionInfo } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';
import { FallbackLlmBackend } from '../../src/llm/FallbackLlmBackend.js';
import { createFauxBackend } from './faux-llm.js';

describe('e2e — FallbackLlmBackend wrapping faux', () => {
  it('uses primary model on success — onFallback never fires', async () => {
    const inner = createFauxBackend({
      turns: [{ text: 'primary OK' }],
    });
    const onFallback = vi.fn();
    const fb = new FallbackLlmBackend(inner, ['secondary'], onFallback);

    const captured: string[] = [];
    const callback = async (text: (string | null | undefined)[]) => {
      captured.push(text.filter((t): t is string => !!t).join(''));
    };
    await fb.complete('primary', [{ role: 'user', content: 'hi' }], { tools: [] }, callback);

    expect(captured).toEqual(['primary OK']);
    expect(onFallback).not.toHaveBeenCalled();
    expect(inner.callCount).toBe(1);
  });

  it('falls back to secondary when primary throws before any callback', async () => {
    // The faux only supports one backend at a time. To simulate a primary
    // that fails AND a secondary that succeeds, wrap two scripts behind a
    // single ICompletionBackend façade keyed on currentModel/argument.
    const primaryError = new Error('rate limit');
    let callCount = 0;
    const dual: ICompletionBackend = {
      currentModel: 'primary',
      pushToolMessages: vi.fn(),
      getModelInfo: async () => [],
      complete: async (
        model: string,
        _msgs: IMessage[],
        _opts: Partial<ICompletionOptions>,
        callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
      ) => {
        callCount++;
        if (model === 'primary') throw primaryError;
        await callback(['secondary OK'], { inputTokens: 10, outputTokens: 5, toolsUsed: [] });
      },
    };

    const onFallback = vi.fn();
    const fb = new FallbackLlmBackend(dual, ['secondary'], onFallback);

    const captured: string[] = [];
    const callback = async (text: (string | null | undefined)[]) => {
      captured.push(text.filter((t): t is string => !!t).join(''));
    };
    await fb.complete('primary', [{ role: 'user', content: 'hi' }], { tools: [] }, callback);

    expect(captured).toEqual(['secondary OK']);
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith('primary', 'secondary', primaryError);
    expect(callCount).toBe(2);
  });

  it('discards partial output from a failed attempt and falls back cleanly (no double-fire)', async () => {
    // The canonical partial-output path: primary streams a chunk, THEN throws.
    // The decorator buffers inner deliveries and flushes only on success, so the
    // primary's partial output is discarded and only the secondary's result is
    // delivered - exactly once, with no double-fire.
    const primaryError = new Error('connection reset');
    const inner: ICompletionBackend = {
      currentModel: 'primary',
      pushToolMessages: vi.fn(),
      getModelInfo: async () => [],
      complete: async (
        model: string,
        _msgs: IMessage[],
        _opts: Partial<ICompletionOptions>,
        callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
      ) => {
        if (model === 'primary') {
          await callback(['partial chunk'], {});
          throw primaryError;
        }
        await callback(['secondary fallback'], {});
      },
    };

    const onFallback = vi.fn();
    const fb = new FallbackLlmBackend(inner, ['secondary'], onFallback);

    const captured: string[] = [];
    const callback = vi.fn(async (text: (string | null | undefined)[]) => {
      captured.push(text.filter((t): t is string => !!t).join(''));
    });

    await fb.complete('primary', [{ role: 'user', content: 'hi' }], { tools: [] }, callback);

    // Only the successful fallback's output is delivered, exactly once -
    // the primary's discarded partial chunk never reaches the caller.
    expect(callback).toHaveBeenCalledOnce();
    expect(captured).toEqual(['secondary fallback']);
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith('primary', 'secondary', primaryError);
  });
});
