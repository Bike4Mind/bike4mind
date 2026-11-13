import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findAssessment: vi.fn(),
  findDetection: vi.fn(),
  createPending: vi.fn(),
  recordAiDecision: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  abuseAssessmentRepository: { findById: h.findAssessment },
  shadowDetectionRepository: { findById: h.findDetection },
  adminAiSuggestionRepository: { createPending: h.createPending },
}));
vi.mock('./audit', () => ({ recordAiDecision: h.recordAiDecision }));

import {
  recordDetectionAssessmentDecision,
  recordUserAssessmentOverride,
  userAssessmentSuggestion,
} from './assessmentSuggestion';

const ASSESSMENT_ID = 'a'.repeat(24);
const SUGGESTION_ID = 'c'.repeat(24);
const USER_ID = '1'.repeat(24);
const DECIDER = { userId: 'admin-1', name: 'Reviewer' };

const assessment = (result: string, detectionId = 'det-1') => ({
  id: ASSESSMENT_ID,
  detectionId,
  result,
  probabilities: [],
  confidence: 0.9,
  reasons: [{ key: 'shared_network', probability: 0.72 }],
  model: 'decision-model',
  policyVersion: 3,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.createPending.mockImplementation(async (input: Record<string, unknown>) => ({ ...input, id: SUGGESTION_ID }));
  h.recordAiDecision.mockResolvedValue({ id: SUGGESTION_ID });
});

describe('recordDetectionAssessmentDecision', () => {
  const decide = (verdict: 'confirmed_abuse' | 'legitimate_human', overrideReason?: string) =>
    recordDetectionAssessmentDecision({
      detectionId: 'det-1',
      verdict,
      aiDecision: { assessmentId: ASSESSMENT_ID, ...(overrideReason ? { overrideReason } : {}) },
      fallbackReason: 'Grader note',
      decidedBy: DECIDER,
    });

  it('stores a per-surface suggestion for the assessment and records a matching grade as accepted', async () => {
    h.findAssessment.mockResolvedValue(assessment('abuse'));

    await expect(decide('confirmed_abuse')).resolves.toBe(SUGGESTION_ID);

    expect(h.createPending).toHaveBeenCalledWith({
      feature: 'detectionTriage',
      entityType: 'shadowDetection',
      entityId: 'det-1',
      inputHash: `shadowDetection:${ASSESSMENT_ID}`,
      policyVersion: '3',
      model: 'decision-model',
      verdict: 'abuse',
      confidence: { probability: 0.9, band: 'high' },
      reasons: [{ text: 'shared_network (72%)', evidenceLinks: [] }],
      proposedAction: { verdict: 'confirmed_abuse' },
      costUsd: 0,
      latencyMs: 0,
    });
    expect(h.recordAiDecision).toHaveBeenCalledWith(SUGGESTION_ID, 'accepted', {
      decidedBy: DECIDER,
      overrideAction: null,
      overrideReason: null,
      overrideCostly: false,
    });
  });

  it('records a different grade as an override with the why-wrong reason', async () => {
    h.findAssessment.mockResolvedValue(assessment('abuse'));

    await decide('legitimate_human', 'Evidence misread');

    expect(h.recordAiDecision).toHaveBeenCalledWith(SUGGESTION_ID, 'overridden', {
      decidedBy: DECIDER,
      overrideAction: { verdict: 'legitimate_human' },
      overrideReason: 'Evidence misread',
      overrideCostly: false,
    });
  });

  it("falls back to the grader's reason when no why-wrong reason was picked", async () => {
    h.findAssessment.mockResolvedValue(assessment('abuse'));

    await decide('legitimate_human');

    expect(h.recordAiDecision).toHaveBeenCalledWith(
      SUGGESTION_ID,
      'overridden',
      expect.objectContaining({ overrideReason: 'Grader note' })
    );
  });

  it.each([
    ['a missing assessment', null, 'Assessment not found'],
    ['an unknown result', assessment('unknown'), 'Assessment not found'],
    ['another detection', assessment('abuse', 'det-2'), 'another detection'],
  ])('refuses %s without storing anything', async (_label, stored, message) => {
    h.findAssessment.mockResolvedValue(stored);

    await expect(decide('confirmed_abuse')).rejects.toThrow(message);
    expect(h.createPending).not.toHaveBeenCalled();
    expect(h.recordAiDecision).not.toHaveBeenCalled();
  });
});

describe('userAssessmentSuggestion', () => {
  it('stores the suggestion under the queue that showed it', async () => {
    h.findAssessment.mockResolvedValue(assessment('abuse'));
    h.findDetection.mockResolvedValue({ id: 'det-1', userIds: [USER_ID] });

    await userAssessmentSuggestion('heldSignupGrant', USER_ID, ASSESSMENT_ID);

    expect(h.createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'abuseAssessment',
        entityType: 'heldSignupGrant',
        entityId: USER_ID,
        inputHash: `heldSignupGrant:${ASSESSMENT_ID}`,
        proposedAction: { action: 'keep_held' },
      })
    );
  });

  it('never offers a non-abuse judgment as a suggestion', async () => {
    h.findAssessment.mockResolvedValue(assessment('legitimate_automation'));

    await expect(userAssessmentSuggestion('signupRiskReview', USER_ID, ASSESSMENT_ID)).rejects.toThrow(
      'Only an abuse assessment'
    );
    expect(h.createPending).not.toHaveBeenCalled();
  });

  it('refuses an assessment whose detection does not name the account', async () => {
    h.findAssessment.mockResolvedValue(assessment('abuse'));
    h.findDetection.mockResolvedValue({ id: 'det-1', userIds: ['2'.repeat(24)] });

    await expect(userAssessmentSuggestion('signupRiskReview', USER_ID, ASSESSMENT_ID)).rejects.toThrow(
      'does not name this account'
    );
    expect(h.createPending).not.toHaveBeenCalled();
  });
});

describe('recordUserAssessmentOverride', () => {
  it('records the credit action taken against the suggestion as a costly override', async () => {
    await recordUserAssessmentOverride({ id: SUGGESTION_ID } as Parameters<typeof recordUserAssessmentOverride>[0], {
      overrideAction: { action: 'release' },
      overrideReason: 'Missing context',
      decidedBy: DECIDER,
    });

    expect(h.recordAiDecision).toHaveBeenCalledWith(SUGGESTION_ID, 'overridden', {
      decidedBy: DECIDER,
      overrideAction: { action: 'release' },
      overrideReason: 'Missing context',
      overrideCostly: true,
    });
  });
});
