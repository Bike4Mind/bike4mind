import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VideoModels, type ModelInfo } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { aiVideoService } from '@bike4mind/utils';
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

vi.mock('axios', () => ({ default: { get: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]) })) } }));

vi.mock('./questHeartbeat', () => ({ startQuestHeartbeat: vi.fn(async () => () => {}) }));

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  updateMetadata: vi.fn(),
} as unknown as Logger;

// statusLog timestamps are wall-clock, so only the status sequence is pinned.
const statusLog = (...statuses: string[]) => statuses.map(status => ({ status, timestamp: expect.any(Date) }));

describe('VideoGenerationService.invoke (retry quest bound to its session)', () => {
  const makeInvokeService = (questSessionId: string) => {
    const update = vi.fn(async () => undefined);
    const startVideoGenerationProcess = vi.fn(async (): Promise<void> => undefined);
    const service = new VideoGenerationService({
      db: {
        sessions: { findById: vi.fn(async () => ({ id: 'session1' })) },
        quests: { findById: vi.fn(async () => ({ id: 'quest1', sessionId: questSessionId })), update },
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
    expect(update).toHaveBeenCalled();
  });

  it('writes only the reset fields when retrying a quest', async () => {
    const { invoke, update } = makeInvokeService('session1');
    await invoke();
    expect(update).toHaveBeenCalledTimes(1);
    expect((update.mock.calls[0] as unknown[])[0]).toStrictEqual({
      id: 'quest1',
      videos: [],
      replies: [],
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
    });
  });

  it('writes only the error fields when starting the process fails', async () => {
    const { invoke, update, startVideoGenerationProcess } = makeInvokeService('session1');
    startVideoGenerationProcess.mockRejectedValue(new Error('queue down'));
    await invoke();
    const calls = update.mock.calls as unknown[][];
    const errorWrite = calls.find(c => (c[0] as { type?: string }).type === 'error');
    expect(errorWrite?.[0]).toStrictEqual({ id: 'quest1', type: 'error', reply: 'queue down' });
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
