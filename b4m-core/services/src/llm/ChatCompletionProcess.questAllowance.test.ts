import { describe, expect, it, vi } from 'vitest';
import { ChatModels, ForbiddenError } from '@bike4mind/common';
import { ChatCompletionProcess } from './ChatCompletionProcess';

describe('QuestMaster process admission', () => {
  it('refuses before all initialization and credit work', async () => {
    const refusal = new ForbiddenError('Free quest already started', { errorCode: 'free_quest_limit_reached' });
    const admitQuestStart = vi.fn().mockRejectedValue(refusal);
    const holdCredits = vi.fn();
    const findQuest = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const process = new ChatCompletionProcess({
      logger,
      user: { id: 'user' },
      admitQuestStart,
      db: {
        adminSettings: { getSettingsValue: vi.fn().mockResolvedValue(true) },
        users: { incrementCredits: holdCredits },
        quests: { findById: findQuest },
      },
    } as unknown as ConstructorParameters<typeof ChatCompletionProcess>[0]);

    await expect(
      process.process({
        body: {
          enableQuestMaster: true,
          params: { model: 'gpt-4' },
          questId: 'quest',
          questMasterStartId: 'admitted-start',
          questAdmittedAs: 'free',
        },
        logger,
      } as unknown as Parameters<ChatCompletionProcess['process']>[0])
    ).rejects.toBe(refusal);
    expect(admitQuestStart).toHaveBeenCalledWith({ id: 'user' }, 'admitted-start');
    expect(findQuest).not.toHaveBeenCalled();
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'continuation', questMaster: { questMasterPlanId: 'plan', questId: 'main', subQuestId: 'sub' } },
    { name: 'subscriber redelivery after lapse', questMasterStartId: 'paid-start', questAdmittedAs: 'subscriber' },
    { name: 'disabled feature', enabled: false },
    { name: 'incompatible model', model: ChatModels.GPT5_2_CHAT_LATEST },
  ])('does not re-admit a $name', async scenario => {
    const admitQuestStart = vi.fn().mockRejectedValue(new Error('subscription lapsed'));
    const sentinel = new Error('initialization reached');
    const findQuest = vi.fn().mockRejectedValue(sentinel);
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const process = new ChatCompletionProcess({
      logger,
      user: { id: 'user' },
      admitQuestStart,
      db: {
        adminSettings: { getSettingsValue: vi.fn().mockResolvedValue('enabled' in scenario ? scenario.enabled : true) },
        quests: { findById: findQuest },
      },
    } as unknown as ConstructorParameters<typeof ChatCompletionProcess>[0]);
    await expect(
      process.process({
        body: {
          userId: 'user',
          sessionId: 'session',
          message: 'hello',
          messageFileIds: [],
          historyCount: 0,
          fabFileIds: [],
          promptMeta: {},
          queryComplexity: 'simple',
          enableQuestMaster: true,
          params: { model: 'model' in scenario ? scenario.model : 'gpt-4' },
          questId: 'quest',
          ...scenario,
        },
        logger,
      } as unknown as Parameters<ChatCompletionProcess['process']>[0])
    ).rejects.toBe(sentinel);
    expect(admitQuestStart).not.toHaveBeenCalled();
    expect(findQuest).toHaveBeenCalledOnce();
  });

  it('requires admission metadata for an eligible new plan', async () => {
    const logger = { info: vi.fn() };
    const admitQuestStart = vi.fn();
    const process = new ChatCompletionProcess({
      logger,
      user: { id: 'user' },
      admitQuestStart,
      db: { adminSettings: { getSettingsValue: vi.fn().mockResolvedValue(true) } },
    } as unknown as ConstructorParameters<typeof ChatCompletionProcess>[0]);
    await expect(
      process.process({
        body: { enableQuestMaster: true, params: { model: 'gpt-4' }, questId: 'quest' },
        logger,
      } as unknown as Parameters<ChatCompletionProcess['process']>[0])
    ).rejects.toThrow('QuestMaster start admission is required');
    expect(admitQuestStart).not.toHaveBeenCalled();
  });
});
