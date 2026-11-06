import { describe, expect, it, vi } from 'vitest';
import { ChatCompletionProcess } from './ChatCompletionProcess';

type Quest = Parameters<ChatCompletionProcess['sendStatusUpdate']>[0];

function makeService(onStatusUpdate?: (questId: string, status: string) => void) {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const sendStatusUpdate = vi.fn().mockResolvedValue(undefined);
  // The options are a wide host-wiring bag; the status path reads only the logger and observer.
  const service = new ChatCompletionProcess({
    logger,
    wsHttpsUrl: '',
    user: { id: 'user1' },
    onStatusUpdate,
  } as unknown as ConstructorParameters<typeof ChatCompletionProcess>[0]);
  (service as unknown as { statusManager: unknown }).statusManager = { sendStatusUpdate };
  return { service, logger, sendStatusUpdate };
}

const quest = { id: 'quest-1' } as unknown as Quest;

describe('ChatCompletionProcess status observer', () => {
  it('reports non-silent status lines and still forwards them to the status manager', async () => {
    const observer = vi.fn();
    const { service, sendStatusUpdate } = makeService(observer);

    await service.sendStatusUpdate(quest, 'Searching the web');
    await service.sendStatusUpdateRapidReply(quest, 'Quick reply');

    expect(observer.mock.calls).toEqual([
      ['quest-1', 'Searching the web'],
      ['quest-1', 'Quick reply'],
    ]);
    expect(sendStatusUpdate).toHaveBeenCalledTimes(2);
  });

  it('ignores clears and silent updates', async () => {
    const observer = vi.fn();
    const { service } = makeService(observer);

    await service.sendStatusUpdate(quest, null);
    await service.sendStatusUpdate(quest, 'quiet', { silent: true });

    expect(observer).not.toHaveBeenCalled();
  });

  it('never lets a throwing observer reach the turn', async () => {
    const { service, logger, sendStatusUpdate } = makeService(() => {
      throw new Error('boom');
    });

    await expect(service.sendStatusUpdate(quest, 'Working')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(sendStatusUpdate).toHaveBeenCalledTimes(1);
  });
});
