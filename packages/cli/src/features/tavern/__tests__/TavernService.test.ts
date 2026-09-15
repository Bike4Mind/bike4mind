import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TavernService } from '../TavernService.js';
import type { ApiClient } from '../../../auth/ApiClient.js';

function createMockApiClient(): ApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as ApiClient;
}

describe('TavernService — quest workflow methods', () => {
  let apiClient: ReturnType<typeof createMockApiClient>;
  let service: TavernService;

  beforeEach(() => {
    apiClient = createMockApiClient();
    service = new TavernService(apiClient);
  });

  describe('getQuestPlan', () => {
    it('calls GET /api/quest-master-plans/[id] with the plan ID as query param', async () => {
      const mockPlan = { _id: 'plan-1', goal: 'Test', quests: [] };
      (apiClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockPlan);

      const result = await service.getQuestPlan('plan-1');

      expect(apiClient.get).toHaveBeenCalledWith('/api/quest-master-plans/plan-1');
      expect(result).toEqual(mockPlan);
    });
  });

  describe('updateReviewGate', () => {
    it('calls POST /api/quest-master-plans/[id]/review-gate', async () => {
      const mockResponse = { success: true };
      (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const result = await service.updateReviewGate('plan-1', 'quest-1', 'sq-1', 'approved', 'LGTM');

      expect(apiClient.post).toHaveBeenCalledWith('/api/quest-master-plans/plan-1/review-gate', {
        questId: 'quest-1',
        subQuestId: 'sq-1',
        reviewStatus: 'approved',
        reviewNote: 'LGTM',
      });
      expect(result).toEqual(mockResponse);
    });
  });

  describe('updateSubQuestProgress', () => {
    it('calls POST /api/quest-master-plans/[id]/subquest-progress', async () => {
      const mockResponse = { success: true, metrics: { completionRate: 0.5 } };
      (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const result = await service.updateSubQuestProgress('plan-1', 'quest-1', 'sq-1', {
        status: 'completed',
        evidence: 'Tests pass',
      });

      expect(apiClient.post).toHaveBeenCalledWith('/api/quest-master-plans/plan-1/subquest-progress', {
        questId: 'quest-1',
        subQuestId: 'sq-1',
        status: 'completed',
        evidence: 'Tests pass',
      });
      expect(result).toEqual(mockResponse);
    });
  });

  describe('updateHandoff', () => {
    it('calls POST /api/quest-master-plans/[id]/handoff', async () => {
      const mockResponse = { success: true };
      (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const result = await service.updateHandoff('plan-1', {
        summary: 'Done with phase 1',
        nextSteps: ['Phase 2'],
        pendingDecisions: [],
        blockers: [],
      });

      expect(apiClient.post).toHaveBeenCalledWith('/api/quest-master-plans/plan-1/handoff', {
        summary: 'Done with phase 1',
        nextSteps: ['Phase 2'],
        pendingDecisions: [],
        blockers: [],
      });
      expect(result).toEqual(mockResponse);
    });
  });
});
