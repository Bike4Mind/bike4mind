import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTavernTools } from '../tavernTools.js';
import type { ITavernService } from '../ITavernService.js';

function createMockService(): ITavernService {
  return {
    listAgents: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    mentionAgent: vi.fn(),
    listQuests: vi.fn(),
    postQuest: vi.fn(),
    deleteQuest: vi.fn(),
    getAgentNotebook: vi.fn(),
    listGates: vi.fn(),
    resolveGate: vi.fn(),
    toggleHeartbeats: vi.fn(),
    triggerHeartbeat: vi.fn(),
    abortHeartbeats: vi.fn(),
    getQuestPlan: vi.fn(),
    updateReviewGate: vi.fn(),
    updateSubQuestProgress: vi.fn(),
    updateHandoff: vi.fn(),
  };
}

describe('Quest Workflow Tools', () => {
  let service: ReturnType<typeof createMockService>;
  let tools: ReturnType<typeof createTavernTools>;

  beforeEach(() => {
    service = createMockService();
    tools = createTavernTools(service);
  });

  function findTool(name: string) {
    const tool = tools.find(t => t.toolSchema.name === name);
    if (!tool) throw new Error(`Tool ${name} not found`);
    return tool;
  }

  describe('tavern_get_quest_plan', () => {
    it('exists in the tools array', () => {
      expect(findTool('tavern_get_quest_plan')).toBeDefined();
    });

    it('calls service.getQuestPlan with the plan_id', async () => {
      const mockPlan = { _id: 'plan-1', goal: 'Test', quests: [] };
      (service.getQuestPlan as ReturnType<typeof vi.fn>).mockResolvedValue(mockPlan);

      const result = await findTool('tavern_get_quest_plan').toolFn({ plan_id: 'plan-1' });

      expect(service.getQuestPlan).toHaveBeenCalledWith('plan-1');
      expect(JSON.parse(result)).toEqual(mockPlan);
    });
  });

  describe('tavern_update_review_gate', () => {
    it('exists in the tools array', () => {
      expect(findTool('tavern_update_review_gate')).toBeDefined();
    });

    it('calls service.updateReviewGate with correct params', async () => {
      const mockResponse = { success: true };
      (service.updateReviewGate as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const result = await findTool('tavern_update_review_gate').toolFn({
        plan_id: 'plan-1',
        quest_id: 'quest-1',
        sub_quest_id: 'sq-1',
        review_status: 'approved',
        review_note: 'LGTM',
      });

      expect(service.updateReviewGate).toHaveBeenCalledWith('plan-1', 'quest-1', 'sq-1', 'approved', 'LGTM');
      expect(JSON.parse(result)).toEqual(mockResponse);
    });
  });

  describe('tavern_update_quest_progress', () => {
    it('exists in the tools array', () => {
      expect(findTool('tavern_update_quest_progress')).toBeDefined();
    });

    it('calls service.updateSubQuestProgress with correct params', async () => {
      const mockResponse = { success: true, metrics: { completionRate: 1.0 } };
      (service.updateSubQuestProgress as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const result = await findTool('tavern_update_quest_progress').toolFn({
        plan_id: 'plan-1',
        quest_id: 'quest-1',
        sub_quest_id: 'sq-1',
        status: 'completed',
        evidence: 'All tests pass',
      });

      expect(service.updateSubQuestProgress).toHaveBeenCalledWith('plan-1', 'quest-1', 'sq-1', {
        status: 'completed',
        evidence: 'All tests pass',
      });
      expect(JSON.parse(result)).toEqual(mockResponse);
    });
  });

  describe('tavern_write_handoff', () => {
    it('exists in the tools array', () => {
      expect(findTool('tavern_write_handoff')).toBeDefined();
    });

    it('calls service.updateHandoff with correct params', async () => {
      const mockResponse = { success: true };
      (service.updateHandoff as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const result = await findTool('tavern_write_handoff').toolFn({
        plan_id: 'plan-1',
        summary: 'Phase 1 done',
        next_steps: ['Start phase 2'],
        pending_decisions: ['Pick DB'],
        blockers: [],
      });

      expect(service.updateHandoff).toHaveBeenCalledWith('plan-1', {
        summary: 'Phase 1 done',
        nextSteps: ['Start phase 2'],
        pendingDecisions: ['Pick DB'],
        blockers: [],
      });
      expect(JSON.parse(result)).toEqual(mockResponse);
    });
  });

  it('total tool count is 19 (15 existing + 4 new)', () => {
    expect(tools).toHaveLength(19);
  });
});
