import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getLlmByModel } from '@bike4mind/llm-adapters';
import { ResearchModeService } from './ResearchModeService';

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

    // Each config must have received the turn's signal, not a copy of it.
    for (const call of complete.mock.calls) {
      expect(call[2].abortSignal).toBe(controller.signal);
    }

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

    expect(complete.mock.calls[0][2].abortSignal).toBeUndefined();
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
