import { describe, it, expect, vi } from 'vitest';
import { VideoGenerationService } from './VideoGeneration';

describe('VideoGenerationService.invoke (retry quest bound to its session)', () => {
  const makeInvokeService = (questSessionId: string) => {
    const update = vi.fn(async () => undefined);
    const startVideoGenerationProcess = vi.fn(async () => undefined);
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
});
