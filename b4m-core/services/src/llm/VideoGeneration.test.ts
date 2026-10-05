import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelBackend, VideoModels, type ModelInfo } from '@bike4mind/common';
import { silentLogger, statusLog } from '../__tests__/utils/testUtils';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { aiVideoService, getSettingsValue } from '@bike4mind/utils';
import { deductCreditsWithOrgSupport } from '../creditService';
import { VideoGenerationService } from './VideoGeneration';

vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return { ...actual, getAvailableModels: vi.fn() };
});

vi.mock('../apiKeyService', async importOriginal => {
  const actual = await importOriginal<typeof import('../apiKeyService')>();
  return { ...actual, getEffectiveLLMApiKeys: vi.fn(async () => ({ openai: 'openai-key' })) };
});

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    aiVideoService: vi.fn(),
    getSettingsMap: vi.fn(async () => ({})),
    getSettingsValue: vi.fn(() => undefined),
    ClientMessageSender: class {
      sendToClient = vi.fn();
    },
  };
});

vi.mock('../creditService', async importOriginal => {
  const actual = await importOriginal<typeof import('../creditService')>();
  return { ...actual, deductCreditsWithOrgSupport: vi.fn(async () => undefined) };
});

vi.mock('axios', () => ({ default: { get: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]) })) } }));

vi.mock('./questHeartbeat', () => ({ startQuestHeartbeat: vi.fn(async () => () => {}) }));

describe('VideoGenerationService.invoke (retry quest bound to its session)', () => {
  const makeInvokeService = (questSessionId: string) => {
    const update = vi.fn(async () => undefined);
    const startVideoGenerationProcess = vi.fn(async (): Promise<void> => undefined);
    const service = new VideoGenerationService({
      db: {
        sessions: { findById: vi.fn(async () => ({ id: 'session1' })) },
        quests: {
          findById: vi.fn(async () => ({
            id: 'quest1',
            sessionId: questSessionId,
            // The prior run failed; the retry must not inherit its error state.
            status: 'done',
            type: 'error',
            errorCode: 'insufficient_credits',
          })),
          update,
        },
      },
      startVideoGenerationProcess,
    } as never);
    const invoke = () =>
      service.invoke({
        body: { sessionId: 'session1', questId: 'quest1', prompt: 'a cat surfing' } as never,
        userId: 'user1',
      });
    return { invoke, update, startVideoGenerationProcess };
  };

  it('refuses a questId from another session before touching the quest', async () => {
    const { invoke, update, startVideoGenerationProcess } = makeInvokeService('other-session');
    await expect(invoke()).rejects.toThrow('Quest not found');
    expect(update).not.toHaveBeenCalled();
    expect(startVideoGenerationProcess).not.toHaveBeenCalled();
  });

  it('retries a quest from the same session', async () => {
    const { invoke, update } = makeInvokeService('session1');
    await invoke();
    expect(update).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'quest1', type: 'message' }), {
      unset: ['status', 'errorCode'],
    });
  });

  const retryResetWrite = {
    id: 'quest1',
    videos: [],
    replies: [],
    type: 'message',
    promptMeta: {
      model: {
        name: VideoModels.SORA_2,
        parameters: { model: VideoModels.SORA_2, seconds: 4, size: '720x1280' },
        type: 'video',
      },
      session: { id: 'session1', userId: 'user1' },
      prompt: 'a cat surfing',
      questId: 'quest1',
      statusLog: statusLog('Video generation started'),
    },
  };

  it('writes only the reset fields when retrying a quest', async () => {
    const { invoke, update } = makeInvokeService('session1');
    await invoke();
    expect(update).toHaveBeenCalledTimes(1);
    expect((update.mock.calls[0] as unknown[])[0]).toStrictEqual(retryResetWrite);
    expect(update.mock.calls[0][1]).toStrictEqual({ unset: ['status', 'errorCode'] });
  });

  it('writes only the error fields when starting the process fails', async () => {
    const { invoke, update, startVideoGenerationProcess } = makeInvokeService('session1');
    startVideoGenerationProcess.mockRejectedValue(new Error('queue down'));
    await invoke();
    // The retry reset, then the error write; a third (e.g. a whole-quest write) is a regression.
    expect(update).toHaveBeenCalledTimes(2);
    expect((update.mock.calls[0] as unknown[])[0]).toStrictEqual(retryResetWrite);
    expect(update.mock.calls[0][1]).toStrictEqual({ unset: ['status', 'errorCode'] });
    const calls = update.mock.calls as unknown[][];
    const errorWrite = calls.find(c => (c[0] as { type?: string }).type === 'error');
    expect(errorWrite?.[0]).toStrictEqual({ id: 'quest1', type: 'error', status: 'done', reply: 'queue down' });
  });
});

describe('VideoGenerationService.process (partial quest writes)', () => {
  const generateSpy = vi.fn();

  const makeService = () => {
    const quest = { id: 'quest1', sessionId: 'session1', prompt: 'a cat surfing', replies: [], videos: [] };
    const update = vi.fn(async () => quest);
    const service = new VideoGenerationService({
      db: {
        quests: { findById: vi.fn(async () => quest), update },
        users: { findById: vi.fn(async () => ({ id: 'user1' })) },
        organizations: { findById: vi.fn(async () => null) },
      },
      startVideoGenerationProcess: vi.fn(),
      wsHttpsUrl: 'wss://example.invalid',
      abilityGetter: vi.fn(),
      logEvent: vi.fn(),
      storage: { upload: vi.fn(async () => 'videos/out.mp4') },
    } as never);
    return { service, update };
  };

  const run = async () => {
    const { service, update } = makeService();
    await service.process({
      body: { sessionId: 'session1', questId: 'quest1', userId: 'user1', prompt: 'a cat surfing' } as never,
      logger: silentLogger,
    });
    return update.mock.calls as unknown[][];
  };

  beforeEach(() => {
    generateSpy.mockReset();
    vi.mocked(aiVideoService).mockReturnValue({ generate: generateSpy } as never);
    vi.mocked(getAvailableModels).mockResolvedValue([{ id: VideoModels.SORA_2 } as unknown as ModelInfo]);
  });

  it('writes only the result fields on success', async () => {
    generateSpy.mockResolvedValue(['https://example.invalid/video.mp4']);
    const calls = await run();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toStrictEqual({
      id: 'quest1',
      reply: '',
      replies: [],
      videos: ['videos/out.mp4'],
      status: 'done',
      promptMeta: {
        performance: { totalResponseTime: expect.any(Number), modelInferenceTime: expect.any(Number) },
        session: { id: 'session1', userId: 'user1' },
        statusLog: statusLog(
          'Preparing to generate video...',
          'Generating video... This may take several minutes.',
          'Storing your video...',
          'Adding to the notebook...',
          'Video generation completed'
        ),
      },
      creditsUsed: undefined,
    });
  });

  it('writes only the error fields when generation fails', async () => {
    generateSpy.mockRejectedValue(new Error('render failed'));
    const calls = await run();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toStrictEqual({
      id: 'quest1',
      prompt: 'a cat surfing',
      reply: 'render failed',
      type: 'error',
      status: 'done',
      errorCode: undefined,
      promptMeta: {
        session: { id: 'session1', userId: 'user1' },
        statusLog: statusLog(
          'Preparing to generate video...',
          'Generating video... This may take several minutes.',
          'Error: render failed'
        ),
      },
    });
  });
});

const generateVideo = vi.fn();

const sora = {
  id: VideoModels.SORA_2,
  type: 'video',
  name: VideoModels.SORA_2,
  backend: ModelBackend.OpenAI,
  contextWindow: 10000,
  max_tokens: 10000,
  pricing: { 1: { input: 0, output: 0 } },
} as unknown as ModelInfo;

describe('VideoGenerationService.process usage event on a charged generation', () => {
  const runCharged = async (record?: ReturnType<typeof vi.fn>) => {
    const quest = { id: 'quest1', sessionId: 'session1', status: undefined as string | undefined } as Record<
      string,
      unknown
    >;
    const service = new VideoGenerationService({
      db: {
        quests: { findById: vi.fn(async () => quest), update: vi.fn(async () => quest) },
        users: { findById: vi.fn(async () => ({ id: 'user1', currentCredits: 1_000_000 })) },
        organizations: { findById: vi.fn(async () => null) },
        creditTransactions: { create: vi.fn() },
        ...(record ? { usageEvents: { record } } : {}),
      },
      startVideoGenerationProcess: vi.fn(),
      wsHttpsUrl: 'https://ws.example.com',
      abilityGetter: vi.fn(),
      logEvent: vi.fn(async () => undefined),
      storage: { upload: vi.fn(async () => 'videos/out.mp4') },
    } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).validateUserCredits = vi.fn(async () => ({ requiredCredits: 120, usdCost: 0.4 }));

    await service.process({
      body: { sessionId: 'session1', questId: 'quest1', userId: 'user1', prompt: 'a bike ride' } as never,
      logger: silentLogger,
    });
    return quest;
  };

  beforeEach(() => {
    vi.mocked(deductCreditsWithOrgSupport).mockClear();
    vi.mocked(getAvailableModels).mockResolvedValue([sora]);
    vi.mocked(getSettingsValue).mockImplementation(name => name === 'enforceCredits' || undefined);
    vi.mocked(silentLogger.warn).mockClear();
    vi.mocked(aiVideoService).mockReturnValue({ generate: generateVideo } as never);
    generateVideo.mockReset();
    generateVideo.mockResolvedValue(['https://example.invalid/video.mp4']);
  });

  afterEach(() => {
    vi.mocked(getSettingsValue).mockImplementation(() => undefined);
  });

  it('has landed the usage event by the time process() returns', async () => {
    let landed = false;
    // Settles on a later macrotask, so an unawaited write is still pending when process() resolves.
    const record = vi.fn(
      () =>
        new Promise<void>(resolve =>
          setTimeout(() => {
            landed = true;
            resolve();
          }, 0)
        )
    );

    const quest = await runCharged(record);

    expect(quest.status).toBe('done');
    expect(deductCreditsWithOrgSupport).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'quest1', feature: 'video_generation', creditsCharged: 120 })
    );
    expect(landed).toBe(true);
  });

  it('still completes the generation when the usage-event write fails', async () => {
    const record = vi.fn(async () => {
      throw new Error('usage store down');
    });

    const quest = await runCharged(record);

    expect(record).toHaveBeenCalledTimes(1);
    expect(quest.type).not.toBe('error');
    expect(quest.status).toBe('done');
    expect(silentLogger.warn).toHaveBeenCalledWith('Failed to record usage event', expect.any(Error));
  });

  it('completes a charged run when db.usageEvents is absent', async () => {
    const quest = await runCharged();

    expect(quest.status).toBe('done');
    expect(quest.type).not.toBe('error');
  });
});
