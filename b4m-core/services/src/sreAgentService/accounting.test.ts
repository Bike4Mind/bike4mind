import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatModels, ModelBackend, type ModelInfo } from '@bike4mind/common';
import { AnthropicBackend, OpenAIBackend, type CompletionInfo, type ICompletionBackend } from '@bike4mind/llm-adapters';
import type { PlatformAccounting } from '../billing/platformAccounting';
import { SreAccountingError, SreCompletionMeter, type SreAccountingContext } from './accounting';

const model = (): ModelInfo => ({
  id: 'metered-model',
  name: 'Metered model',
  type: 'text',
  backend: ModelBackend.Anthropic,
  contextWindow: 100000,
  max_tokens: 1000,
  pricing: { 100000: { input: 1e-6, output: 2e-6, cache_read: 0.1e-6, cache_write: 1.25e-6 } },
});
const messages = [{ role: 'user' as const, content: 'diagnose' }];
const measured: CompletionInfo = { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 10 };
function harness() {
  const accounting = {
    diagnostics: vi.fn().mockResolvedValue({ attempts: [], total: 0, byState: {} }),
    register: vi.fn(async input => ({ ...input, state: 'registered', createdAt: new Date(), updatedAt: new Date() })),
    claimDispatch: vi.fn().mockResolvedValue(true),
    settle: vi.fn().mockResolvedValue(undefined),
    unresolved: vi.fn().mockResolvedValue(undefined),
  };
  const context: SreAccountingContext = {
    accounting: accounting as unknown as PlatformAccounting,
    attribution: {
      kind: 'platform_operation',
      operation: 'sre_diagnosis',
      environment: 'test',
      logicalJobId: 'job',
      executionId: 'execution',
    },
    deadlineAt: Date.now() + 60_000,
    persistenceReserveMs: 10_000,
  };
  const complete = vi.fn<ICompletionBackend['complete']>(async (_model, _messages, _options, callback) => {
    await callback(['answer'], measured);
  });
  const backend = { complete } as unknown as ICompletionBackend;
  const text = vi.fn().mockResolvedValue(undefined);
  return { accounting, context, complete, backend, text, meter: new SreCompletionMeter(context) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SRE provider accounting', () => {
  it('requires trusted accounting context before inference', async () => {
    const h = harness();
    await expect(new SreCompletionMeter().complete(h.backend, model(), messages, {}, h.text)).rejects.toMatchObject({
      reason: 'missing_context',
    });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('awaits durable intent and atomic admission before one provider send', async () => {
    const h = harness();
    const admitted = Promise.withResolvers<boolean>();
    h.accounting.claimDispatch.mockReturnValue(admitted.promise);
    const pending = h.meter.complete(h.backend, model(), messages, { maxTokens: 50 }, h.text);
    await vi.waitFor(() => expect(h.accounting.claimDispatch).toHaveBeenCalledOnce());
    expect(h.complete).not.toHaveBeenCalled();
    admitted.resolve(true);
    await pending;
    expect(h.complete).toHaveBeenCalledExactlyOnceWith(
      'metered-model',
      messages,
      expect.objectContaining({
        stream: false,
        retryMode: 'single-attempt',
        executeTools: false,
        abortSignal: expect.any(AbortSignal),
      }),
      expect.any(Function)
    );
    expect(h.accounting.settle).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({
        provider: 'anthropic',
        model: 'metered-model',
        providerInputTokens: 100,
        providerOutputTokens: 20,
        creditsCharged: 0,
        status: 'ok',
      })
    );
    expect(h.accounting.settle.mock.calls[0][1]).not.toHaveProperty('userId');
  });

  it('does not send when registration or dispatch claim fails', async () => {
    for (const failure of ['register', 'claim'] as const) {
      const h = harness();
      if (failure === 'register') h.accounting.register.mockRejectedValue(new Error('database unavailable'));
      else h.accounting.claimDispatch.mockResolvedValue(false);
      await expect(h.meter.complete(h.backend, model(), messages, {}, h.text)).rejects.toMatchObject({
        reason: failure === 'register' ? 'admission_failed' : 'admission_refused',
      });
      expect(h.complete).not.toHaveBeenCalled();
    }
  });

  it('awaits settlement before returning the response', async () => {
    const h = harness();
    const persisted = Promise.withResolvers<void>();
    h.accounting.settle.mockReturnValue(persisted.promise);
    const finished = vi.fn();
    const pending = h.meter.complete(h.backend, model(), messages, {}, h.text).then(finished);
    await vi.waitFor(() => expect(h.accounting.settle).toHaveBeenCalledOnce());
    expect(finished).not.toHaveBeenCalled();
    persisted.resolve();
    await pending;
    expect(finished).toHaveBeenCalledOnce();
  });

  it('surfaces a settlement fault without another provider call', async () => {
    const h = harness();
    h.accounting.settle.mockRejectedValue(new Error('write failed'));
    await expect(h.meter.complete(h.backend, model(), messages, {}, h.text)).rejects.toMatchObject({
      reason: 'settlement_failed',
    });
    expect(h.complete).toHaveBeenCalledOnce();
    expect(h.accounting.unresolved).not.toHaveBeenCalled();
  });

  it('settles latched provider usage on errors before propagating the provider fault', async () => {
    const h = harness();
    const fault = new Error('provider failed after usage');
    h.complete.mockImplementation(async (_model, _messages, _options, callback) => {
      await callback([], measured);
      throw fault;
    });
    await expect(h.meter.complete(h.backend, model(), messages, {}, h.text)).rejects.toBe(fault);
    expect(h.accounting.settle.mock.calls[0][1]).toMatchObject({
      status: 'error',
      providerInputTokens: 100,
      providerOutputTokens: 20,
    });
  });

  it.each([undefined, { inputTokens: 100 }, { outputTokens: 20 }])(
    'durably marks missing or incomplete provider usage unresolved (%s)',
    async usage => {
      const h = harness();
      h.complete.mockImplementation(async (_model, _messages, _options, callback) => {
        await callback(['answer'], usage);
      });
      await expect(h.meter.complete(h.backend, model(), messages, {}, h.text)).rejects.toMatchObject({
        reason: 'provider_usage_unresolved',
      });
      expect(h.accounting.unresolved).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'missing_usage');
      expect(h.accounting.settle).not.toHaveBeenCalled();
    }
  );

  it('fails visibly if even unresolved persistence fails', async () => {
    const h = harness();
    h.complete.mockRejectedValue(new Error('provider unavailable'));
    h.accounting.unresolved.mockRejectedValue(new Error('database unavailable'));
    await expect(h.meter.complete(h.backend, model(), messages, {}, h.text)).rejects.toMatchObject({
      reason: 'unresolved_persistence_failed',
    });
  });

  it('joins an aborted transport and settles its late actual usage as timeout', async () => {
    vi.useFakeTimers();
    const h = harness();
    const transport = Promise.withResolvers<void>();
    const opened = Promise.withResolvers<AbortSignal>();
    h.complete.mockImplementation(async (_model, _messages, options, callback) => {
      opened.resolve(options.abortSignal!);
      await transport.promise;
      await callback([], measured);
    });
    const finished = vi.fn();
    const result = h.meter.complete(h.backend, model(), messages, {}, h.text).catch(finished);
    const signal = await opened.promise;
    await vi.advanceTimersByTimeAsync(50_000);
    expect(signal.aborted).toBe(true);
    expect(finished).not.toHaveBeenCalled();
    expect(h.accounting.settle).not.toHaveBeenCalled();
    transport.resolve();
    await result;
    expect(h.accounting.settle.mock.calls[0][1]).toMatchObject({
      status: 'timeout',
      providerInputTokens: 100,
      providerOutputTokens: 20,
    });
    expect(h.complete).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledOnce();
  });

  it('does not start a new round after the absolute provider deadline', async () => {
    const h = harness();
    h.context.deadlineAt = Date.now() + 5000;
    await expect(h.meter.complete(h.backend, model(), messages, {}, h.text)).rejects.toMatchObject({
      reason: 'deadline_exhausted',
    });
    expect(h.accounting.register).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('freezes selected model pricing before any asynchronous admission work', async () => {
    const h = harness();
    const selected = model();
    h.accounting.register.mockImplementation(async input => {
      selected.pricing[100000].input = 99;
      return { ...input, state: 'registered', createdAt: new Date(), updatedAt: new Date() };
    });
    await h.meter.complete(h.backend, selected, messages, {}, h.text);
    expect(h.accounting.settle.mock.calls[0][1].costUsd).toBeCloseTo(0.000141);
  });

  it('assigns distinct deterministic identifiers to actual tool rounds and emergency sends', async () => {
    const h = harness();
    await h.meter.complete(h.backend, model(), messages, {}, h.text);
    await h.meter.complete(h.backend, model(), messages, {}, h.text);
    const first = h.accounting.register.mock.calls[0][0].providerCallId;
    expect(h.accounting.register.mock.calls[1][0].providerCallId).not.toBe(first);
    h.accounting.claimDispatch.mockResolvedValue(false);
    await expect(
      new SreCompletionMeter(h.context).complete(h.backend, model(), messages, {}, h.text)
    ).rejects.toBeInstanceOf(SreAccountingError);
    expect(h.accounting.register.mock.calls[2][0].providerCallId).toBe(first);
    expect(h.complete).toHaveBeenCalledTimes(2);
  });

  it('reuses a live registered receipt lease before the first paid dispatch', async () => {
    const h = harness();
    await h.meter.complete(h.backend, model(), messages, {}, h.text);
    const registered = h.accounting.register.mock.calls[0][0];
    const originalLease = new Date(Date.now() + 30_000);
    h.accounting.diagnostics.mockResolvedValue({
      total: 1,
      byState: {},
      attempts: [{ ...registered, state: 'registered', leaseExpiresAt: originalLease }],
    });
    await new SreCompletionMeter(h.context).complete(h.backend, model(), messages, {}, h.text);
    expect(h.accounting.register.mock.calls[1][0].leaseExpiresAt).toEqual(originalLease);
  });

  it('preserves the exact one-hour cache write component of a single measured turn', async () => {
    const h = harness();
    h.complete.mockImplementation(async (_model, _messages, _options, callback) => {
      await callback([], {
        ...measured,
        cacheCreationInputTokens: 20,
        turnUsage: [
          { ...measured, inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 20, cacheWrite1hInputTokens: 5 },
        ],
      });
    });
    await h.meter.complete(h.backend, model(), messages, {}, h.text);
    expect(h.accounting.settle.mock.calls[0][1]).toMatchObject({ cacheWriteTokens: 20, cacheWrite1hTokens: 5 });
  });

  it.each([
    { inputTokens: -1, outputTokens: 2 },
    { inputTokens: NaN, outputTokens: 2 },
    { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 1, cacheWrite1hInputTokens: 2 },
  ])('durably isolates invalid measured usage %s without inventing a known-cost fact', async usage => {
    const h = harness();
    h.complete.mockImplementation(async (_model, _messages, _options, callback) => {
      await callback([], usage);
    });
    await expect(h.meter.complete(h.backend, model(), messages, {}, h.text)).rejects.toMatchObject({
      reason: 'invalid_provider_usage',
    });
    expect(h.accounting.unresolved).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'missing_usage');
    expect(h.accounting.settle).not.toHaveBeenCalled();
  });

  it('keeps the known receipt when later text callbacks omit or replace token counts', async () => {
    const h = harness();
    h.complete.mockImplementation(async (_model, _messages, _options, callback) => {
      await callback([], measured);
      await callback(['answer'], { inputTokens: undefined, outputTokens: NaN });
      throw new Error('content parse failed');
    });
    await expect(h.meter.complete(h.backend, model(), messages, {}, h.text)).rejects.toThrow('content parse failed');
    expect(h.accounting.settle.mock.calls[0][1]).toMatchObject({
      status: 'error',
      providerInputTokens: 100,
      providerOutputTokens: 20,
    });
    expect(h.accounting.unresolved).not.toHaveBeenCalled();
  });

  it('settles latched usage even if the text consumer itself throws', async () => {
    const h = harness();
    h.text.mockRejectedValue(new Error('text handler failed'));
    await expect(h.meter.complete(h.backend, model(), messages, {}, h.text)).rejects.toThrow('text handler failed');
    expect(h.accounting.settle.mock.calls[0][1]).toMatchObject({
      status: 'error',
      providerInputTokens: 100,
      providerOutputTokens: 20,
    });
  });

  it.each(['anthropic', 'openai'] as const)(
    'leaves %s mismatched or absent SDK model identity unresolved without a priced ledger fact',
    async provider => {
      const requestedModel = provider === 'anthropic' ? ChatModels.CLAUDE_4_6_SONNET : ChatModels.GPT4o;
      for (const returnedModel of [undefined, 'different-model', requestedModel + '-20990101']) {
        const h = harness();
        const selected = {
          ...model(),
          id: requestedModel,
          backend: provider === 'anthropic' ? ModelBackend.Anthropic : ModelBackend.OpenAI,
        };
        const fetch = vi.fn(async () =>
          provider === 'anthropic'
            ? Response.json({
                id: 'message',
                type: 'message',
                role: 'assistant',
                model: returnedModel,
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'answer' }],
                usage: { input_tokens: 100, output_tokens: 20 },
              })
            : Response.json({
                id: 'response',
                object: 'chat.completion',
                created: 0,
                model: returnedModel,
                choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 100, completion_tokens: 20 },
              })
        );
        vi.stubGlobal('fetch', fetch);
        const logger = {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          log: vi.fn(),
        } as unknown as import('@bike4mind/observability').Logger;
        const backend =
          provider === 'anthropic' ? new AnthropicBackend('test', logger) : new OpenAIBackend('test', logger);
        await expect(h.meter.complete(backend, selected, messages, { maxTokens: 200 }, h.text)).rejects.toMatchObject({
          reason: 'provider_usage_unresolved',
        });
        expect(h.accounting.unresolved).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'missing_usage');
        expect(h.accounting.settle).not.toHaveBeenCalled();
        expect(h.text).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledOnce();
      }
    }
  );

  it('prices the actual OpenAI cached response once with disjoint prompt buckets', async () => {
    const h = harness();
    const selected: ModelInfo = {
      ...model(),
      id: ChatModels.GPT4o,
      backend: ModelBackend.OpenAI,
      pricing: { 100000: { input: 0.001, output: 0.002, cache_read: 0.0001, cache_write: 0.00125 } },
    };
    const fetch = vi.fn(async () =>
      Response.json({
        id: 'response',
        object: 'chat.completion',
        created: 0,
        model: selected.id,
        choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } },
      })
    );
    vi.stubGlobal('fetch', fetch);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    } as unknown as import('@bike4mind/observability').Logger;
    await h.meter.complete(new OpenAIBackend('test', logger), selected, messages, { maxTokens: 200 }, h.text);
    expect(fetch).toHaveBeenCalledOnce();
    expect(h.accounting.settle).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({
        provider: 'openai',
        model: selected.id,
        inputTokens: 0,
        outputTokens: 0,
        providerInputTokens: 600,
        providerOutputTokens: 100,
        cachedInputTokens: 400,
        cacheWriteTokens: 0,
        rates: expect.objectContaining({ input: 0.001, output: 0.002, cacheRead: 0.0001 }),
      })
    );
    expect(h.accounting.settle.mock.calls[0][1].costUsd).toBeCloseTo(0.84, 12);
    expect(h.accounting.unresolved).not.toHaveBeenCalled();
  });

  it('prices the actual Anthropic response once with cache reads and both write durations disjoint', async () => {
    const h = harness();
    const selected: ModelInfo = {
      ...model(),
      id: ChatModels.CLAUDE_4_6_SONNET,
      pricing: { 100000: { input: 0.001, output: 0.002, cache_read: 0.0001, cache_write: 0.00125 } },
    };
    const fetch = vi.fn(async () =>
      Response.json({
        id: 'message',
        type: 'message',
        role: 'assistant',
        model: selected.id,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'answer' }],
        usage: {
          input_tokens: 600,
          output_tokens: 100,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 200,
          cache_creation: { ephemeral_5m_input_tokens: 150, ephemeral_1h_input_tokens: 50 },
        },
      })
    );
    vi.stubGlobal('fetch', fetch);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    } as unknown as import('@bike4mind/observability').Logger;
    await h.meter.complete(new AnthropicBackend('test', logger), selected, messages, { maxTokens: 200 }, h.text);
    expect(fetch).toHaveBeenCalledOnce();
    expect(h.accounting.settle).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({
        provider: 'anthropic',
        model: selected.id,
        inputTokens: 0,
        outputTokens: 0,
        providerInputTokens: 600,
        providerOutputTokens: 100,
        cachedInputTokens: 400,
        cacheWriteTokens: 200,
        cacheWrite1hTokens: 50,
        rates: expect.objectContaining({
          input: 0.001,
          output: 0.002,
          cacheRead: 0.0001,
          cacheWrite: 0.00125,
          cacheWrite1h: 0.002,
        }),
      })
    );
    expect(h.accounting.settle.mock.calls[0][1].costUsd).toBeCloseTo(1.1275, 12);
    expect(h.accounting.unresolved).not.toHaveBeenCalled();
  });
});
