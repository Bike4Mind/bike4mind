import { describe, expect, it, vi } from 'vitest';
import { ChatCompletionProcess } from './ChatCompletionProcess';
import { ALL_FEATURE_NAMES } from './ChatCompletionFeatures';

// The in-chat QuestMaster plan path is gone. Bodies queued by an older server, or sent by an older
// client, can still carry its fields; they must run as ordinary turns.
describe('ChatCompletionProcess with a retired QuestMaster body', () => {
  const legacyBody = {
    userId: 'user',
    sessionId: 'session',
    message: 'plan my week',
    messageFileIds: [],
    historyCount: 0,
    fabFileIds: [],
    promptMeta: {},
    queryComplexity: 'complex',
    params: { model: 'gpt-4' },
    questId: 'quest',
    enableQuestMaster: true,
    questMasterStartId: 'free-start',
    questAdmittedAs: 'free',
  };

  it('goes straight to initialization without reading the QuestMaster setting or admitting a start', async () => {
    const sentinel = new Error('initialization reached');
    const findQuest = vi.fn().mockRejectedValue(sentinel);
    const getSettingsValue = vi.fn().mockResolvedValue(true);
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), log: vi.fn() };
    const process = new ChatCompletionProcess({
      logger,
      user: { id: 'user' },
      db: {
        adminSettings: { getSettingsValue },
        quests: { findById: findQuest },
      },
    } as unknown as ConstructorParameters<typeof ChatCompletionProcess>[0]);

    await expect(
      process.process({ body: legacyBody, logger } as unknown as Parameters<ChatCompletionProcess['process']>[0])
    ).rejects.toBe(sentinel);
    expect(getSettingsValue).not.toHaveBeenCalled();
    expect(findQuest).toHaveBeenCalledOnce();
    expect(findQuest).toHaveBeenCalledWith('quest');
  });

  it('has no questMaster feature to build', () => {
    expect(ALL_FEATURE_NAMES).not.toContain('questMaster');
  });
});
