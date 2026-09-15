import { describe, it, expect } from 'vitest';
import {
  QuestPlanResponseSchema,
  UpdateReviewGateRequestSchema,
  UpdateSubQuestProgressRequestSchema,
  UpdateHandoffRequestSchema,
} from '../types.js';

describe('Quest Workflow Schemas', () => {
  describe('QuestPlanResponseSchema', () => {
    it('parses a valid quest plan response', () => {
      const input = {
        _id: '507f1f77bcf86cd799439011',
        notebookId: '507f1f77bcf86cd799439012',
        goal: 'Build the thing',
        state: 'active',
        quests: [
          {
            id: 'quest-1',
            title: 'Setup',
            description: 'Initial setup',
            complexity: 'low',
            subQuests: [
              {
                id: 'sq-1',
                title: 'Install deps',
                status: 'completed',
                evidence: 'pnpm install succeeded',
              },
              {
                id: 'sq-2',
                title: 'Write schema',
                status: 'not_started',
                reviewGate: true,
                reviewStatus: 'pending',
              },
            ],
          },
        ],
        handoff: {
          summary: 'Got deps installed',
          nextSteps: ['Write schema'],
          pendingDecisions: [],
          blockers: [],
          lastUpdatedBy: 'session-123',
          updatedAt: '2026-04-28T00:00:00Z',
        },
      };
      const result = QuestPlanResponseSchema.parse(input);
      expect(result.quests[0].subQuests).toHaveLength(2);
      expect(result.quests[0].subQuests[1].reviewGate).toBe(true);
    });
  });

  describe('UpdateReviewGateRequestSchema', () => {
    it('parses valid approve request', () => {
      const result = UpdateReviewGateRequestSchema.parse({
        planId: '507f1f77bcf86cd799439011',
        questId: 'quest-1',
        subQuestId: 'sq-2',
        reviewStatus: 'approved',
        reviewNote: 'Looks good',
      });
      expect(result.reviewStatus).toBe('approved');
    });

    it('rejects invalid reviewStatus', () => {
      expect(() =>
        UpdateReviewGateRequestSchema.parse({
          planId: '507f1f77bcf86cd799439011',
          questId: 'quest-1',
          subQuestId: 'sq-2',
          reviewStatus: 'maybe',
        })
      ).toThrow();
    });
  });

  describe('UpdateSubQuestProgressRequestSchema', () => {
    it('parses valid progress update with evidence', () => {
      const result = UpdateSubQuestProgressRequestSchema.parse({
        planId: '507f1f77bcf86cd799439011',
        questId: 'quest-1',
        subQuestId: 'sq-1',
        status: 'completed',
        evidence: 'All tests pass',
      });
      expect(result.status).toBe('completed');
      expect(result.evidence).toBe('All tests pass');
    });
  });

  describe('UpdateHandoffRequestSchema', () => {
    it('parses valid handoff request', () => {
      const result = UpdateHandoffRequestSchema.parse({
        planId: '507f1f77bcf86cd799439011',
        summary: 'Completed phase 1',
        nextSteps: ['Start phase 2'],
        pendingDecisions: ['Which DB to use'],
        blockers: [],
      });
      expect(result.nextSteps).toEqual(['Start phase 2']);
    });
  });
});
