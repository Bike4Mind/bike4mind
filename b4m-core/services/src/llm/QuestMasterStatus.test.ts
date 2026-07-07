import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuestMasterFeature, ChatCompletionContext } from './ChatCompletionFeatures';

/**
 * Tests for the QuestMaster status state machine in processQuestMasterTask.
 *
 * SubQuestStatus type: 'not_started' | 'in_progress' | 'completed' | 'skipped' | 'deleted'
 *
 * Status transitions:
 * - not_started: Proceed with processing
 * - in_progress: Proceed (re-processing, e.g., after page refresh)
 * - completed: Skip (already done)
 * - skipped: Skip (explicitly skipped by user)
 * - deleted: Proceed (edge case - not in skip list)
 *
 * Note: 'blocked' is NOT a valid SubQuestStatus.
 */
describe('QuestMasterFeature - Status State Machine', () => {
  let feature: QuestMasterFeature;
  let mockContext: ChatCompletionContext;
  let mockDb: any;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      updateMetadata: vi.fn(),
    };

    mockDb = {
      questMasterPlans: {
        findById: vi.fn(),
        getSubQuest: vi.fn(),
        updateTaskStatus: vi.fn(),
      },
      quests: {
        findById: vi.fn(),
        update: vi.fn(),
      },
    };

    mockContext = {
      user: { id: 'user1' } as any,
      slackWebhookUrl: '',
      userAbility: {} as any,
      autoNameSession: vi.fn(),
      invokeCreateMemento: vi.fn(),
      logEvent: vi.fn(),
      db: mockDb,
      sessionId: 'session1',
      summarizeSession: vi.fn(),
      logger: mockLogger,
      sendStatusUpdate: vi.fn(),
      fabFilesToMessages: vi.fn(),
    };

    feature = new QuestMasterFeature(mockContext);
  });

  const questMasterParams = {
    questMasterPlanId: 'plan1',
    questId: 'quest1',
    subQuestId: 'subquest1',
  };

  const mockQuestMasterPlan = {
    id: 'plan1',
    quests: [{ id: 'quest1', subQuests: [{ id: 'subquest1', title: 'Test SubQuest' }] }],
  };

  describe('beforeDataGathering with questMaster params', () => {
    it('should skip processing when subQuest status is completed', async () => {
      mockDb.questMasterPlans.findById.mockResolvedValue(mockQuestMasterPlan);
      mockDb.questMasterPlans.getSubQuest.mockResolvedValue({ id: 'subquest1', status: 'completed' });

      const result = await feature.beforeDataGathering({
        quest: {} as any,
        session: {} as any,
        startParams: {} as any,
        llm: {} as any,
        model: 'gpt-4',
        message: 'test',
        historyCount: 0,
        fabFileIds: [],
        questId: 'quest1',
        questMaster: questMasterParams,
      });

      expect(result.shouldContinue).toBe(true);
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('is completed. Skipping.'));
      expect(mockDb.questMasterPlans.updateTaskStatus).not.toHaveBeenCalled();
    });

    it('should skip processing when subQuest status is skipped', async () => {
      mockDb.questMasterPlans.findById.mockResolvedValue(mockQuestMasterPlan);
      mockDb.questMasterPlans.getSubQuest.mockResolvedValue({ id: 'subquest1', status: 'skipped' });

      const result = await feature.beforeDataGathering({
        quest: {} as any,
        session: {} as any,
        startParams: {} as any,
        llm: {} as any,
        model: 'gpt-4',
        message: 'test',
        historyCount: 0,
        fabFileIds: [],
        questId: 'quest1',
        questMaster: questMasterParams,
      });

      expect(result.shouldContinue).toBe(true);
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('is skipped. Skipping.'));
      expect(mockDb.questMasterPlans.updateTaskStatus).not.toHaveBeenCalled();
    });

    it('should proceed with processing when subQuest status is not_started', async () => {
      mockDb.questMasterPlans.findById.mockResolvedValue(mockQuestMasterPlan);
      mockDb.questMasterPlans.getSubQuest.mockResolvedValue({ id: 'subquest1', status: 'not_started' });

      const result = await feature.beforeDataGathering({
        quest: {} as any,
        session: {} as any,
        startParams: {} as any,
        llm: {} as any,
        model: 'gpt-4',
        message: 'test',
        historyCount: 0,
        fabFileIds: [],
        questId: 'quest1',
        questMaster: questMasterParams,
      });

      expect(result.shouldContinue).toBe(true);
      expect(mockDb.questMasterPlans.updateTaskStatus).toHaveBeenCalledWith(
        'plan1',
        'quest1',
        'subquest1',
        'in_progress'
      );
    });

    it('should proceed with re-processing when subQuest status is in_progress', async () => {
      mockDb.questMasterPlans.findById.mockResolvedValue(mockQuestMasterPlan);
      mockDb.questMasterPlans.getSubQuest.mockResolvedValue({ id: 'subquest1', status: 'in_progress' });

      const result = await feature.beforeDataGathering({
        quest: {} as any,
        session: {} as any,
        startParams: {} as any,
        llm: {} as any,
        model: 'gpt-4',
        message: 'test',
        historyCount: 0,
        fabFileIds: [],
        questId: 'quest1',
        questMaster: questMasterParams,
      });

      expect(result.shouldContinue).toBe(true);
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('is already in_progress. Re-processing.'));
      expect(mockDb.questMasterPlans.updateTaskStatus).toHaveBeenCalledWith(
        'plan1',
        'quest1',
        'subquest1',
        'in_progress'
      );
    });

    // 'blocked' is not a valid SubQuestStatus in the type system.
    // SubQuestStatus only includes: 'not_started' | 'in_progress' | 'completed' | 'skipped' | 'deleted'
    // The 'blocked' status is not part of the QuestMasterPlan subquest vocabulary.

    it('should proceed when subQuest status is deleted (edge case)', async () => {
      mockDb.questMasterPlans.findById.mockResolvedValue(mockQuestMasterPlan);
      mockDb.questMasterPlans.getSubQuest.mockResolvedValue({ id: 'subquest1', status: 'deleted' });

      const result = await feature.beforeDataGathering({
        quest: {} as any,
        session: {} as any,
        startParams: {} as any,
        llm: {} as any,
        model: 'gpt-4',
        message: 'test',
        historyCount: 0,
        fabFileIds: [],
        questId: 'quest1',
        questMaster: questMasterParams,
      });

      // 'deleted' is not in the skip list (completed, skipped), so it proceeds
      expect(result.shouldContinue).toBe(true);
      expect(mockDb.questMasterPlans.updateTaskStatus).toHaveBeenCalledWith(
        'plan1',
        'quest1',
        'subquest1',
        'in_progress'
      );
    });

    it('should handle missing questMasterPlan gracefully', async () => {
      mockDb.questMasterPlans.findById.mockResolvedValue(null);

      const result = await feature.beforeDataGathering({
        quest: {} as any,
        session: {} as any,
        startParams: {} as any,
        llm: {} as any,
        model: 'gpt-4',
        message: 'test',
        historyCount: 0,
        fabFileIds: [],
        questId: 'quest1',
        questMaster: questMasterParams,
      });

      expect(result.shouldContinue).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    it('should handle missing subQuest gracefully', async () => {
      mockDb.questMasterPlans.findById.mockResolvedValue(mockQuestMasterPlan);
      mockDb.questMasterPlans.getSubQuest.mockResolvedValue(null);

      const result = await feature.beforeDataGathering({
        quest: {} as any,
        session: {} as any,
        startParams: {} as any,
        llm: {} as any,
        model: 'gpt-4',
        message: 'test',
        historyCount: 0,
        fabFileIds: [],
        questId: 'quest1',
        questMaster: questMasterParams,
      });

      expect(result.shouldContinue).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Sub quest with id subquest1 not found'));
    });
  });
});
