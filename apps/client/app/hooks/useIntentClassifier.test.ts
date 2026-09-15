import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import { useIntentClassifier, CLASSIFIER_TIMEOUT_MS } from './useIntentClassifier';
import type { ClassifyIntentInput } from './useIntentClassifier';

/**
 * Tests for the M4 client-side wrapper. Focus: the four outcome
 * branches (`decided` / `skipped` / `timeout` / `error`), the 400 ms client
 * abort budget, the per-user cache key namespacing, and the in-tab dedupe.
 *
 * Real `fetch` is stubbed per test - we don't hit the network.
 */

const renderWithClient = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
};

const baseInput: ClassifyIntentInput = {
  userId: 'user-A',
  message: 'compare TypeScript versus Flow trade-offs',
  hasFileAttachments: false,
  hasAgentMention: false,
};

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useIntentClassifier', () => {
  it('returns `decided` when the server returns a usable decision', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          decision: {
            useAgent: true,
            confidence: 0.85,
            reason: 'multi-step research',
            signals: ['research'],
            classifierModel: 'haiku',
            latencyMs: 200,
            cacheHit: false,
            earlyExited: true,
          },
          shadowMode: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const { wrapper } = renderWithClient();
    const { result } = renderHook(() => useIntentClassifier(), { wrapper });
    const outcome = await result.current(baseInput);

    expect(outcome.status).toBe('decided');
    if (outcome.status === 'decided') {
      expect(outcome.decision.useAgent).toBe(true);
      expect(outcome.shadowMode).toBe(false);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('strips `userId` from the request body (server reads it from auth)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          decision: {
            useAgent: false,
            confidence: 0.9,
            reason: 'r',
            signals: [],
            classifierModel: 'haiku',
            latencyMs: 0,
            cacheHit: true,
            earlyExited: false,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );
    const { wrapper } = renderWithClient();
    const { result } = renderHook(() => useIntentClassifier(), { wrapper });
    await result.current(baseInput);

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('userId');
    expect(body).toHaveProperty('message', baseInput.message);
  });

  it('returns `skipped` when the server short-circuits via `skipped: true`', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ skipped: true, reason: 'disabled', shadowMode: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const { wrapper } = renderWithClient();
    const { result } = renderHook(() => useIntentClassifier(), { wrapper });
    const outcome = await result.current(baseInput);
    expect(outcome).toEqual({ status: 'skipped', reason: 'disabled' });
  });

  it('returns `error` on 5xx (no thrown exception escapes)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('cascade exhausted', { status: 503 }));
    const { wrapper } = renderWithClient();
    const { result } = renderHook(() => useIntentClassifier(), { wrapper });
    const outcome = await result.current(baseInput);
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.message).toContain('503');
    }
  });

  it('returns `error` when the server omits `decision` and is not marked skipped', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    const { wrapper } = renderWithClient();
    const { result } = renderHook(() => useIntentClassifier(), { wrapper });
    const outcome = await result.current(baseInput);
    expect(outcome.status).toBe('error');
  });

  it('returns `timeout` when fetch is aborted by the client budget', async () => {
    // Fake timers so the 400 ms budget is exercised instantly - keeps the
    // suite deterministic and removes wall-clock cost if it ever lands in
    // a CI hot path.
    vi.useFakeTimers();

    // Simulate a fetch that respects the abort signal - never resolves on its
    // own, only rejects on abort. Mirrors how a stalled server would behave.
    vi.spyOn(global, 'fetch').mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (!signal) return; // safety; should always be set
          signal.addEventListener('abort', () => {
            const err = new DOMException('aborted', 'AbortError');
            reject(err);
          });
        })
    );
    const { wrapper } = renderWithClient();
    const { result } = renderHook(() => useIntentClassifier(), { wrapper });

    // Sanity: timeout constant matches the documented 400ms budget so a future
    // bump is caught here too.
    expect(CLASSIFIER_TIMEOUT_MS).toBe(400);

    // Kick off the call (returns a pending promise - fetch never resolves on
    // its own), then advance the fake clock past the abort deadline. The
    // `*Async` variant flushes microtasks so the abort propagates through
    // React Query's queryFn rejection chain back to our `catch` block.
    const outcomePromise = result.current(baseInput);
    await vi.advanceTimersByTimeAsync(CLASSIFIER_TIMEOUT_MS);
    const outcome = await outcomePromise;
    expect(outcome).toEqual({ status: 'timeout' });
  });

  it('namespaces cache by userId — A and B do not cross-pollute', async () => {
    // Two distinct payloads keyed by userId. If the cache leaked, the second
    // call would return user-A's response instead of triggering a new fetch.
    const responses: Record<string, unknown> = {
      'user-A': {
        decision: {
          useAgent: true,
          confidence: 0.9,
          reason: 'A',
          signals: [],
          classifierModel: 'haiku',
          latencyMs: 0,
          cacheHit: false,
          earlyExited: false,
        },
      },
      'user-B': {
        decision: {
          useAgent: false,
          confidence: 0.9,
          reason: 'B',
          signals: [],
          classifierModel: 'haiku',
          latencyMs: 0,
          cacheHit: false,
          earlyExited: false,
        },
      },
    };
    let callCount = 0;
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
      callCount += 1;
      // The body has been stripped of userId; we infer which user it's for by
      // call order - first call is A, second is B.
      const which = callCount === 1 ? 'user-A' : 'user-B';
      return new Response(JSON.stringify(responses[which]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { wrapper } = renderWithClient();
    const { result } = renderHook(() => useIntentClassifier(), { wrapper });

    const a = await result.current({ ...baseInput, userId: 'user-A' });
    const b = await result.current({ ...baseInput, userId: 'user-B' });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    if (a.status === 'decided' && b.status === 'decided') {
      expect(a.decision.reason).toBe('A');
      expect(b.decision.reason).toBe('B');
    } else {
      expect.fail('expected both calls to decide');
    }
  });

  it('dedupes identical calls within the cache window (React Query staleTime)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          decision: {
            useAgent: true,
            confidence: 0.9,
            reason: 'r',
            signals: [],
            classifierModel: 'haiku',
            latencyMs: 0,
            cacheHit: false,
            earlyExited: false,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const { wrapper } = renderWithClient();
    const { result } = renderHook(() => useIntentClassifier(), { wrapper });

    await result.current(baseInput);
    await result.current(baseInput);
    await result.current(baseInput);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
