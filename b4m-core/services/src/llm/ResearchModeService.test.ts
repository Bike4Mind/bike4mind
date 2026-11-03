import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLlmByModel } from '@bike4mind/llm-adapters';
import { ChatModels, estimateStreamedOutputTokens, type ModelInfo } from '@bike4mind/common';
import type { ICompletionOptions } from '@bike4mind/llm-adapters';
import { ResearchModeService, researchConfigTimeoutMs } from './ResearchModeService';
import { researchModeUsages } from './ChatCompletionProcess';

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getLlmByModel: vi.fn(),
}));

const mockedGetLlmByModel = vi.mocked(getLlmByModel);

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
const modelInfos = [
  { id: 'model-a', name: 'A' },
  { id: 'model-b', name: 'B' },
] as any;

function researchMode(ids: string[]) {
  return {
    enabled: true,
    configurations: ids.map(id => ({
      id,
      enabled: true,
      model: `model-${id}`,
      parameters: {},
    })),
  };
}

// A backend whose complete() never settles, so only the abort/timeout race can end a config.
function hangingComplete() {
  return vi.fn().mockImplementation(() => new Promise<never>(() => {}));
}

const onStream = vi.fn().mockResolvedValue(undefined);
const baseOptions = {} as any;

describe('ResearchModeService cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aborts every in-flight configuration when the signal fires', async () => {
    const complete = hangingComplete();
    mockedGetLlmByModel.mockReturnValue({ complete } as any);

    const controller = new AbortController();
    const service = new ResearchModeService({}, modelInfos, logger);

    const pending = service.processResearchMode(
      researchMode(['a', 'b']) as any,
      [{ role: 'user', content: 'hi' }],
      baseOptions,
      onStream,
      controller.signal
    );

    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));

    // Each config gets its own signal, linked to the turn's.
    const [signalA, signalB] = complete.mock.calls.map(call => call[2].abortSignal);
    expect(signalA).not.toBe(controller.signal);
    expect(signalA).not.toBe(signalB);

    controller.abort();

    const results = await pending;
    expect(results).toEqual([
      { configurationId: 'a', model: 'model-a', success: false, streamedChars: 0, error: 'Cancelled' },
      { configurationId: 'b', model: 'model-b', success: false, streamedChars: 0, error: 'Cancelled' },
    ]);
    for (const call of complete.mock.calls) {
      expect(call[2].abortSignal.aborted).toBe(true);
    }
  });

  it('skips the LLM call entirely when the signal is already aborted', async () => {
    const complete = hangingComplete();
    mockedGetLlmByModel.mockReturnValue({ complete } as any);

    const controller = new AbortController();
    controller.abort();
    const service = new ResearchModeService({}, modelInfos, logger);

    const results = await service.processResearchMode(
      researchMode(['a']) as any,
      [{ role: 'user', content: 'hi' }],
      baseOptions,
      onStream,
      controller.signal
    );

    expect(complete).not.toHaveBeenCalled();
    expect(results).toEqual([
      { configurationId: 'a', model: 'model-a', success: false, streamedChars: 0, error: 'Cancelled' },
    ]);
  });

  it('behaves as before when no signal is passed', async () => {
    const complete = vi.fn().mockImplementation(async (_model, _messages, _options, cb) => {
      await cb(['Hello ']);
      await cb(['world']);
    });
    mockedGetLlmByModel.mockReturnValue({ complete } as any);

    const service = new ResearchModeService({}, modelInfos, logger);

    const results = await service.processResearchMode(
      researchMode(['a']) as any,
      [{ role: 'user', content: 'hi' }],
      baseOptions,
      onStream
    );

    expect(complete.mock.calls[0][2].abortSignal.aborted).toBe(false);
    expect(results).toEqual([
      {
        configurationId: 'a',
        model: 'model-a',
        success: true,
        response: 'Hello world',
        streamedChars: 11,
        completionInfo: undefined,
      },
    ]);
  });
});

describe('ResearchModeService output ceiling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clamps a configuration's maxTokens to its model's output cap", async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    mockedGetLlmByModel.mockReturnValue({ complete } as any);
    const service = new ResearchModeService({}, [{ id: 'model-a', name: 'A', max_tokens: 8192 }] as any, logger);
    const mode = researchMode(['a']);
    mode.configurations[0].parameters = { maxTokens: 10_000_000 } as any;

    await service.processResearchMode(mode, [], baseOptions, onStream);

    expect(complete.mock.calls[0][2].maxTokens).toBe(8192);
  });

  it('reports what a configuration streamed before it failed, so it can be billed', async () => {
    const complete = vi.fn().mockImplementation(async (_model, _messages, _options, cb) => {
      await cb(['partial answer']);
      throw new Error('provider dropped');
    });
    mockedGetLlmByModel.mockReturnValue({ complete } as any);
    const service = new ResearchModeService({}, modelInfos, logger);

    const results = await service.processResearchMode(researchMode(['a']), [], baseOptions, onStream);

    expect(results[0]).toMatchObject({ success: false, model: 'model-a', streamedChars: 'partial answer'.length });
  });
});

type Backend = ReturnType<typeof getLlmByModel>;
type CompletionCallback = (texts: (string | null | undefined)[], info?: Record<string, unknown>) => Promise<void>;

function useBackend(complete: ReturnType<typeof vi.fn>) {
  mockedGetLlmByModel.mockReturnValue({ complete } as unknown as Backend);
}

function waitForAbort(signal: AbortSignal) {
  return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));
}

describe('researchConfigTimeoutMs', () => {
  it('falls back to the base for a missing or non-positive budget', () => {
    expect(researchConfigTimeoutMs(undefined)).toBe(120_000);
    expect(researchConfigTimeoutMs(0)).toBe(120_000);
    expect(researchConfigTimeoutMs(-5)).toBe(120_000);
    expect(researchConfigTimeoutMs(NaN)).toBe(120_000);
  });

  it('adds the output budget at the slowest expected rate', () => {
    expect(researchConfigTimeoutMs(4000)).toBe(220_000);
    expect(researchConfigTimeoutMs(1)).toBe(120_025);
  });

  it('caps a large budget', () => {
    expect(researchConfigTimeoutMs(64_000)).toBe(600_000);
    expect(researchConfigTimeoutMs(Infinity)).toBe(600_000);
  });
});

describe('ResearchModeService timeout', () => {
  const timedModels = [
    { id: 'model-a', name: 'A', max_tokens: 64_000 },
    { id: 'model-b', name: 'B', max_tokens: 64_000 },
  ] as unknown as ModelInfo[];

  function budgeted(budgets: Record<string, number>) {
    return {
      enabled: true,
      configurations: Object.entries(budgets).map(([id, maxTokens]) => ({
        id,
        enabled: true,
        model: `model-${id}`,
        parameters: { maxTokens },
      })),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts the provider stream on timeout and bills the usage it reports afterwards', async () => {
    let signal: AbortSignal | undefined;
    const complete = vi.fn(async (_model, _messages, options: ICompletionOptions, cb: CompletionCallback) => {
      signal = options.abortSignal;
      await cb(['abc']);
      await waitForAbort(options.abortSignal!);
      await cb(['defgh']);
      await cb([], { inputTokens: 50, outputTokens: 30, stopReason: 'aborted' });
    });
    useBackend(complete);
    const service = new ResearchModeService({}, timedModels, logger);

    const pending = service.processResearchMode(budgeted({ a: 4000 }), [], baseOptions, onStream);
    await vi.advanceTimersByTimeAsync(220_000);
    const results = await pending;

    expect(signal?.aborted).toBe(true);
    expect(results).toEqual([
      {
        configurationId: 'a',
        model: 'model-a',
        success: false,
        streamedChars: 8,
        error: 'Timeout after 220 seconds',
        completionInfo: { inputTokens: 50, outputTokens: 30 },
      },
    ]);
    // Text after the timeout is counted for billing but never reaches the client.
    expect(onStream).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Configuration a timed out'));
    expect(logger.error).not.toHaveBeenCalled();

    const [usage] = researchModeUsages(results, timedModels, 999);
    expect(usage).toMatchObject({ inputTokens: 50, outputTokens: 30 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bills every char streamed until the aborted stream stops when no usage is reported', async () => {
    const complete = vi.fn(async (_model, _messages, options: ICompletionOptions, cb: CompletionCallback) => {
      await cb(['x'.repeat(40)], { channel: 'text', thinking: 'secret' });
      await waitForAbort(options.abortSignal!);
      await cb(['y'.repeat(400)]);
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    useBackend(complete);
    const service = new ResearchModeService({}, timedModels, logger);

    const pending = service.processResearchMode(budgeted({ a: 4000 }), [], baseOptions, onStream);
    await vi.advanceTimersByTimeAsync(220_000);
    const results = await pending;

    // The last info was a mid-stream chunk, so nothing of it (thinking included) is kept.
    expect(results[0]).toMatchObject({ success: false, streamedChars: 440, completionInfo: undefined });
    const [usage] = researchModeUsages(results, timedModels, 999);
    expect(usage).toMatchObject({ inputTokens: 999, outputTokens: estimateStreamedOutputTokens(440, 'model-a') });
  });

  it('gives up on a provider that ignores the abort after a bounded drain, billing past its stale report', async () => {
    const complete = vi.fn(async (_model, _messages, options: ICompletionOptions, cb: CompletionCallback) => {
      await cb(['abc'], { inputTokens: 10, outputTokens: 1 });
      await waitForAbort(options.abortSignal!);
      await cb(['y'.repeat(4000)]);
      await new Promise<never>(() => {});
    });
    useBackend(complete);
    const service = new ResearchModeService({}, timedModels, logger);

    let settled = false;
    const pending = service
      .processResearchMode(budgeted({ a: 4000 }), [], baseOptions, onStream)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(220_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);

    const results = await pending;
    expect(results).toEqual([
      expect.objectContaining({
        success: false,
        streamedChars: 4003,
        error: 'Timeout after 220 seconds',
        // Saved as billed, not as the stale report.
        completionInfo: { inputTokens: 10, outputTokens: estimateStreamedOutputTokens(4003, 'model-a') },
      }),
    ]);
    const [usage] = researchModeUsages(results, timedModels, 999);
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: estimateStreamedOutputTokens(4003, 'model-a') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not abort the quest or a sibling configuration when one times out', async () => {
    const signals: Record<string, AbortSignal> = {};
    const complete = vi.fn(async (model: string, _messages, options: ICompletionOptions, cb: CompletionCallback) => {
      signals[model] = options.abortSignal!;
      if (model === 'model-a') return new Promise<never>(() => {});
      await new Promise(resolve => setTimeout(resolve, 250_000));
      await cb(['done']);
    });
    useBackend(complete);
    const quest = new AbortController();
    const service = new ResearchModeService({}, timedModels, logger);

    const pending = service.processResearchMode(
      budgeted({ a: 4000, b: 8000 }),
      [],
      baseOptions,
      onStream,
      quest.signal
    );
    await vi.advanceTimersByTimeAsync(220_000);

    expect(signals['model-a'].aborted).toBe(true);
    expect(signals['model-b'].aborted).toBe(false);
    expect(quest.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    const results = await pending;
    expect(results.map(r => [r.configurationId, r.success, r.error])).toEqual([
      ['a', false, 'Timeout after 220 seconds'],
      ['b', true, undefined],
    ]);
  });

  it('sizes the timeout on the max_tokens a thinking request really sends', async () => {
    const thinkingModel = {
      id: ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
      name: 'Thinking',
      backend: 'bedrock',
      type: 'text',
      can_think: true,
      thinkingStyle: 'legacy',
      max_tokens: 64_000,
    } as unknown as ModelInfo;
    const signals: Record<string, AbortSignal> = {};
    const complete = vi.fn(async (model: string, _messages, options: ICompletionOptions) => {
      signals[model] = options.abortSignal!;
      await waitForAbort(options.abortSignal!);
    });
    useBackend(complete);
    const service = new ResearchModeService({}, [thinkingModel, timedModels[0]], logger);
    // A sibling on a model that cannot think keeps its own 220s limit.
    const mode = {
      enabled: true,
      configurations: [
        { id: 'a', enabled: true, model: thinkingModel.id, parameters: { maxTokens: 4000 } },
        { id: 'b', enabled: true, model: 'model-a', parameters: { maxTokens: 4000 } },
      ],
    };

    const pending = service.processResearchMode(mode, [], { thinking: { enabled: true } } as any, onStream);
    // The adapter raises 4000 to the 16000 default budget + 1000, so the limit is 120s + 17000 / 40.
    await vi.advanceTimersByTimeAsync(220_000);
    expect(signals[thinkingModel.id].aborted).toBe(false);
    expect(signals['model-a'].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(325_000);
    const results = await pending;

    expect(signals[thinkingModel.id].aborted).toBe(true);
    expect(results.map(r => [r.configurationId, r.error])).toEqual([
      ['a', 'Timeout after 545 seconds'],
      ['b', 'Timeout after 220 seconds'],
    ]);
  });

  it('rounds the timeout in its error message to whole seconds', async () => {
    useBackend(hangingComplete());
    const service = new ResearchModeService({}, timedModels, logger);

    // 120.025s rounds down and 145.6s rounds up, so neither floor nor ceil passes.
    const pending = service.processResearchMode(budgeted({ a: 1, b: 1024 }), [], baseOptions, onStream);
    await vi.advanceTimersByTimeAsync(156_000);
    const results = await pending;

    expect(results.map(r => r.error)).toEqual(['Timeout after 120 seconds', 'Timeout after 146 seconds']);
  });

  it('reports a Stop before the timeout as cancelled, without draining', async () => {
    useBackend(hangingComplete());
    const quest = new AbortController();
    const service = new ResearchModeService({}, timedModels, logger);

    const pending = service.processResearchMode(budgeted({ a: 4000 }), [], baseOptions, onStream, quest.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    quest.abort();
    const results = await pending;

    expect(results[0]).toMatchObject({ success: false, error: 'Cancelled' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases its timer and quest listener once a configuration finishes', async () => {
    let signal: AbortSignal | undefined;
    const complete = vi.fn(async (_model, _messages, options: ICompletionOptions, cb: CompletionCallback) => {
      signal = options.abortSignal;
      await cb(['ok'], { inputTokens: 1, outputTokens: 1 });
    });
    useBackend(complete);
    const quest = new AbortController();
    const removeSpy = vi.spyOn(quest.signal, 'removeEventListener');
    const service = new ResearchModeService({}, timedModels, logger);

    const results = await service.processResearchMode(budgeted({ a: 4000 }), [], baseOptions, onStream, quest.signal);

    expect(results[0]).toMatchObject({ success: true, response: 'ok' });
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    quest.abort();
    expect(signal?.aborted).toBe(false);
  });
});

describe('ResearchModeService edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a research mode that is disabled or has no configurations', async () => {
    const service = new ResearchModeService({}, modelInfos, logger);
    await expect(
      service.processResearchMode({ enabled: false, configurations: [] }, [], baseOptions, onStream)
    ).rejects.toThrow('Research Mode is not properly configured');
    await expect(
      service.processResearchMode({ enabled: true, configurations: [] }, [], baseOptions, onStream)
    ).rejects.toThrow('Research Mode is not properly configured');
  });

  it('skips disabled configurations and reports an unknown model or missing backend', async () => {
    mockedGetLlmByModel.mockReturnValue(undefined as unknown as Backend);
    const service = new ResearchModeService({}, modelInfos, logger);
    const mode = {
      enabled: true,
      configurations: [
        { id: 'a', enabled: true, model: 'model-a', label: 'Alpha', parameters: {} },
        { id: 'z', enabled: true, model: 'model-z', parameters: {} },
        { id: 'off', enabled: false, model: 'model-b', parameters: {} },
      ],
    };

    const results = await service.processResearchMode(mode, [], baseOptions, onStream);

    expect(results.map(r => [r.configurationId, r.error])).toEqual([
      ['a', 'Failed to get LLM instance for model model-a'],
      ['z', 'Model model-z not found'],
    ]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Alpha (a)'));
  });

  it('reports a non-Error failure as unknown', async () => {
    useBackend(vi.fn().mockRejectedValue('boom'));
    const service = new ResearchModeService({}, modelInfos, logger);

    const results = await service.processResearchMode(researchMode(['a']), [], baseOptions, onStream);

    expect(results[0]).toMatchObject({ success: false, error: 'Unknown error' });
  });

  it('still reports a configuration whose processing rejects outright', async () => {
    useBackend(vi.fn().mockRejectedValue(new Error('provider down')));
    const throwingLogger = { ...logger, error: vi.fn() };
    throwingLogger.error
      .mockImplementationOnce(() => {
        throw new Error('logger down');
      })
      .mockImplementationOnce(() => {
        throw 'logger down';
      });
    const service = new ResearchModeService({}, modelInfos, throwingLogger);

    const results = await service.processResearchMode(researchMode(['a', 'b']), [], baseOptions, onStream);

    expect(results).toEqual([
      { configurationId: 'a', model: 'model-a', success: false, streamedChars: 0, error: 'logger down' },
      { configurationId: 'b', model: 'model-b', success: false, streamedChars: 0, error: 'Unknown error' },
    ]);
  });

  it('withholds reasoning, strips thinking, and flushes held text at the end', async () => {
    useBackend(
      vi.fn(async (_model, _messages, _options, cb: CompletionCallback) => {
        await cb(['Hi <thi', null], { thinking: 'hidden', channel: 'text' });
        await cb([null]);
      })
    );
    const ollamaModels = [{ id: 'model-a', name: 'A', backend: 'ollama' }] as unknown as ModelInfo[];
    const service = new ResearchModeService({}, ollamaModels, logger);

    const results = await service.processResearchMode(
      researchMode(['a']),
      [],
      { temperature: 0.2 } as ICompletionOptions,
      onStream,
      undefined,
      'none'
    );

    expect(onStream).toHaveBeenNthCalledWith(1, 'a', ['Hi ', null], { thinking: undefined, channel: 'text' });
    expect(onStream).toHaveBeenLastCalledWith('a', ['<thi']);
    expect(results[0]).toMatchObject({ success: true, response: 'Hi <thi', streamedChars: 7 });
  });

  it('passes the reasoning withholder info through when there is no thinking block', async () => {
    useBackend(
      vi.fn(async (_model, _messages, _options, cb: CompletionCallback) => {
        await cb(['plain'], { channel: 'text' });
      })
    );
    const ollamaModels = [{ id: 'model-a', name: 'A', backend: 'ollama' }] as unknown as ModelInfo[];
    const service = new ResearchModeService({}, ollamaModels, logger);

    const results = await service.processResearchMode(
      researchMode(['a']),
      [],
      baseOptions,
      onStream,
      undefined,
      'none'
    );

    expect(results[0]).toMatchObject({ success: true, response: 'plain', completionInfo: { channel: 'text' } });
  });
});

describe('researchModeUsages', () => {
  const models = [{ id: 'model-a', name: 'A' }] as unknown as ModelInfo[];

  it('bills a successful configuration what its provider reported, even below the streamed estimate', () => {
    const [usage] = researchModeUsages(
      [
        {
          configurationId: 'a',
          model: 'model-a',
          success: true,
          streamedChars: 40_000,
          completionInfo: { inputTokens: 50, outputTokens: 5 },
        },
      ],
      models,
      999
    );

    expect(usage).toMatchObject({ inputTokens: 50, outputTokens: 5 });
  });

  it('bills a failed configuration the streamed estimate when its last report is below it', () => {
    const [usage] = researchModeUsages(
      [
        {
          configurationId: 'a',
          model: 'model-a',
          success: false,
          streamedChars: 40_000,
          error: 'Cancelled',
          completionInfo: { inputTokens: 50, outputTokens: 5 },
        },
      ],
      models,
      999
    );

    expect(usage).toMatchObject({ inputTokens: 50, outputTokens: estimateStreamedOutputTokens(40_000, 'model-a') });
  });
});
