import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@bike4mind/common';
import { ChatCompletionProcess } from './ChatCompletionProcess';

describe('QuestMaster process admission', () => {
  it.each(['admitted-start', undefined])('refuses before all initialization and credit work (%s)', async startId => {
    const refusal = new ForbiddenError('Free quest already started', { errorCode: 'free_quest_limit_reached' });
    const admitQuestStart = vi.fn().mockRejectedValue(refusal);
    const holdCredits = vi.fn();
    const findQuest = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const process = new ChatCompletionProcess({
      logger,
      user: { id: 'user' },
      admitQuestStart,
      db: { users: { incrementCredits: holdCredits }, quests: { findById: findQuest } },
    } as unknown as ConstructorParameters<typeof ChatCompletionProcess>[0]);

    await expect(
      process.process({
        body: { enableQuestMaster: true, questId: 'quest', questMasterStartId: startId },
        logger,
      } as unknown as Parameters<ChatCompletionProcess['process']>[0])
    ).rejects.toBe(refusal);
    expect(admitQuestStart).toHaveBeenCalledWith({ id: 'user' }, startId ?? 'quest');
    expect(findQuest).not.toHaveBeenCalled();
    expect(holdCredits).not.toHaveBeenCalled();
  });
});
