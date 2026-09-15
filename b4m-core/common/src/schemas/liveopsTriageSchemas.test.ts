import { describe, it, expect } from 'vitest';
import {
  TriageResultSchema,
  TriageSummarySchema,
  LLMTriageResponseSchema,
  LIVEOPS_TRIAGE_RESULT_VALIDATION_LIMITS,
} from './settings';

describe('LiveOps Triage Schemas', () => {
  describe('TriageResultSchema', () => {
    const validResult = {
      alertId: 'alert-123',
      priority: 'P1',
      category: 'api',
      title: 'Test Error',
      body: 'Error details here',
      labels: ['bug', 'liveops'],
      matchesExisting: null,
      isRecurring: false,
      occurrenceCount: 1,
      isRegression: false,
    };

    it('should accept valid triage result', () => {
      const result = TriageResultSchema.safeParse(validResult);
      expect(result.success).toBe(true);
    });

    it('should accept all valid priority levels', () => {
      for (const priority of ['P0', 'P1', 'P2', 'P3']) {
        const result = TriageResultSchema.safeParse({ ...validResult, priority });
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid priority level', () => {
      const result = TriageResultSchema.safeParse({ ...validResult, priority: 'P4' });
      expect(result.success).toBe(false);
    });

    it('should accept all valid categories', () => {
      const categories = ['database', 'api', 'auth', 'frontend', 'infrastructure', 'llm', 'integration', 'other'];
      for (const category of categories) {
        const result = TriageResultSchema.safeParse({ ...validResult, category });
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid category', () => {
      const result = TriageResultSchema.safeParse({ ...validResult, category: 'invalid-category' });
      expect(result.success).toBe(false);
    });

    it('should default isRegression to false when not provided', () => {
      const { isRegression, ...withoutRegression } = validResult;
      const result = TriageResultSchema.safeParse(withoutRegression);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isRegression).toBe(false);
      }
    });

    it('should default labels to empty array when not provided', () => {
      const { labels, ...withoutLabels } = validResult;
      const result = TriageResultSchema.safeParse(withoutLabels);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.labels).toEqual([]);
      }
    });

    it('should accept matchesExisting with state', () => {
      const result = TriageResultSchema.safeParse({
        ...validResult,
        matchesExisting: { issueNumber: 123, title: 'Existing Issue', state: 'closed' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.matchesExisting?.state).toBe('closed');
      }
    });

    it('should reject title exceeding max length', () => {
      const longTitle = 'x'.repeat(LIVEOPS_TRIAGE_RESULT_VALIDATION_LIMITS.title.max + 1);
      const result = TriageResultSchema.safeParse({ ...validResult, title: longTitle });
      expect(result.success).toBe(false);
    });

    it('should reject occurrenceCount below minimum', () => {
      const result = TriageResultSchema.safeParse({ ...validResult, occurrenceCount: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject occurrenceCount above maximum', () => {
      const result = TriageResultSchema.safeParse({
        ...validResult,
        occurrenceCount: LIVEOPS_TRIAGE_RESULT_VALIDATION_LIMITS.occurrenceCount.max + 1,
      });
      expect(result.success).toBe(false);
    });

    it('should accept matchedClosedIssue with a string closedAt', () => {
      const result = TriageResultSchema.safeParse({
        ...validResult,
        isRegression: true,
        matchedClosedIssue: { issueNumber: 42, title: 'Closed Issue', closedAt: '2024-02-20T14:30:00Z' },
      });
      expect(result.success).toBe(true);
    });

    // Regression: LLM returned matchedClosedIssue.closedAt = null (it is never given
    // closedAt in the prompt). A non-nullable schema threw and failed the entire
    // triage run. closedAt must tolerate null/omitted values.
    it('should accept matchedClosedIssue with null closedAt (#8805)', () => {
      const result = TriageResultSchema.safeParse({
        ...validResult,
        isRegression: true,
        matchedClosedIssue: { issueNumber: 42, title: 'Closed Issue', closedAt: null },
      });
      expect(result.success).toBe(true);
    });

    it('should accept matchedClosedIssue with closedAt omitted (#8805)', () => {
      const result = TriageResultSchema.safeParse({
        ...validResult,
        isRegression: true,
        matchedClosedIssue: { issueNumber: 42, title: 'Closed Issue' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('TriageSummarySchema', () => {
    const validSummary = {
      totalAlerts: 10,
      newIssues: 5,
      duplicates: 3,
      regressions: 2,
      p0Count: 0,
      p1Count: 1,
      p2Count: 2,
      p3Count: 2,
      recurringPatterns: ['Pattern 1'],
      healthAssessment: 'System is healthy',
    };

    it('should accept valid summary', () => {
      const result = TriageSummarySchema.safeParse(validSummary);
      expect(result.success).toBe(true);
    });

    it('should default regressions to 0 when not provided', () => {
      const { regressions, ...withoutRegressions } = validSummary;
      const result = TriageSummarySchema.safeParse(withoutRegressions);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.regressions).toBe(0);
      }
    });

    it('should default recurringPatterns to empty array', () => {
      const { recurringPatterns, ...withoutPatterns } = validSummary;
      const result = TriageSummarySchema.safeParse(withoutPatterns);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.recurringPatterns).toEqual([]);
      }
    });

    it('should default healthAssessment to empty string', () => {
      const { healthAssessment, ...withoutAssessment } = validSummary;
      const result = TriageSummarySchema.safeParse(withoutAssessment);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.healthAssessment).toBe('');
      }
    });

    it('should reject negative counts', () => {
      const result = TriageSummarySchema.safeParse({ ...validSummary, totalAlerts: -1 });
      expect(result.success).toBe(false);
    });
  });

  describe('LLMTriageResponseSchema', () => {
    const validResponse = {
      triageResults: [
        {
          alertId: 'alert-1',
          priority: 'P1',
          category: 'api',
          title: 'Error 1',
          body: 'Details',
          labels: [],
          matchesExisting: null,
          isRecurring: false,
          occurrenceCount: 1,
          isRegression: false,
        },
      ],
      summary: {
        totalAlerts: 1,
        newIssues: 1,
        duplicates: 0,
        regressions: 0,
        p0Count: 0,
        p1Count: 1,
        p2Count: 0,
        p3Count: 0,
        recurringPatterns: [],
        healthAssessment: 'OK',
      },
    };

    it('should accept valid LLM response', () => {
      const result = LLMTriageResponseSchema.safeParse(validResponse);
      expect(result.success).toBe(true);
    });

    it('should reject response with invalid triageResult', () => {
      const invalidResponse = {
        ...validResponse,
        triageResults: [{ ...validResponse.triageResults[0], priority: 'INVALID' }],
      };
      const result = LLMTriageResponseSchema.safeParse(invalidResponse);
      expect(result.success).toBe(false);
    });

    it('should reject response with invalid summary', () => {
      const invalidResponse = {
        ...validResponse,
        summary: { ...validResponse.summary, totalAlerts: -1 },
      };
      const result = LLMTriageResponseSchema.safeParse(invalidResponse);
      expect(result.success).toBe(false);
    });

    it('should reject response missing triageResults', () => {
      const { triageResults, ...withoutResults } = validResponse;
      const result = LLMTriageResponseSchema.safeParse(withoutResults);
      expect(result.success).toBe(false);
    });

    it('should reject response missing summary', () => {
      const { summary, ...withoutSummary } = validResponse;
      const result = LLMTriageResponseSchema.safeParse(withoutSummary);
      expect(result.success).toBe(false);
    });

    it('should accept empty triageResults array', () => {
      const result = LLMTriageResponseSchema.safeParse({
        ...validResponse,
        triageResults: [],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('Validation Limits', () => {
    it('should have sensible default values', () => {
      expect(LIVEOPS_TRIAGE_RESULT_VALIDATION_LIMITS.occurrenceCount.min).toBe(1);
      expect(LIVEOPS_TRIAGE_RESULT_VALIDATION_LIMITS.occurrenceCount.max).toBeGreaterThan(100);
      expect(LIVEOPS_TRIAGE_RESULT_VALIDATION_LIMITS.title.max).toBeGreaterThan(100);
      expect(LIVEOPS_TRIAGE_RESULT_VALIDATION_LIMITS.body.max).toBeGreaterThan(1000);
    });
  });
});
