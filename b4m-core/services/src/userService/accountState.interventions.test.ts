import { describe, expect, it } from 'vitest';
import type { InterventionHold } from '@bike4mind/common';
import {
  AI_ACCESS_PENDING_REVIEW_MESSAGE,
  AI_ACCESS_UNDER_REVIEW_MESSAGE,
  AI_ACCESS_VERIFICATION_REQUIRED_MESSAGE,
  aiAccessDeniedMessage,
  isAiAccessRefusal,
} from './accountState';

const NOW = new Date('2026-11-24T10:00:00Z');
const HOUR_MS = 3_600_000;

const hold = (tier: InterventionHold['tier'], over: Partial<InterventionHold> = {}): InterventionHold => ({
  decisionId: `decision-${tier}`,
  detectionId: 'detection-1',
  tier,
  policyVersion: 1,
  reason: `Automated ${tier} (policy v1)`,
  appliedAt: NOW,
  expiresAt: new Date(NOW.getTime() + HOUR_MS),
  releasedAt: null,
  releasedBy: null,
  ...over,
});

describe('aiAccessDeniedMessage with automated holds', () => {
  it('explains an active review hold with the support path', () => {
    expect(aiAccessDeniedMessage({ interventionHolds: [hold('review')] }, NOW)).toBe(AI_ACCESS_UNDER_REVIEW_MESSAGE);
    expect(AI_ACCESS_UNDER_REVIEW_MESSAGE).toMatch(/contact support/);
  });

  it('explains an active verify hold with the verification and support paths', () => {
    expect(aiAccessDeniedMessage({ interventionHolds: [hold('verify')] }, NOW)).toBe(
      AI_ACCESS_VERIFICATION_REQUIRED_MESSAGE
    );
    expect(AI_ACCESS_VERIFICATION_REQUIRED_MESSAGE).toMatch(/account settings.*contact support/);
  });

  it('prefers review when both are active', () => {
    expect(aiAccessDeniedMessage({ interventionHolds: [hold('verify'), hold('review')] }, NOW)).toBe(
      AI_ACCESS_UNDER_REVIEW_MESSAGE
    );
  });

  it('allows access once the hold expired or was released, and for limit or holdGrant holds', () => {
    const expired = hold('review', { expiresAt: new Date(NOW.getTime() - 1) });
    const released = hold('verify', { releasedAt: NOW, releasedBy: 'admin-1' });
    expect(aiAccessDeniedMessage({ interventionHolds: [expired, released] }, NOW)).toBeNull();
    expect(aiAccessDeniedMessage({ interventionHolds: [hold('limit'), hold('holdGrant')] }, NOW)).toBeNull();
  });

  it('keeps a manual review hold ahead of an automated one', () => {
    expect(
      aiAccessDeniedMessage({ riskScore: { reviewState: 'pending' }, interventionHolds: [hold('verify')] }, NOW)
    ).toBe(AI_ACCESS_PENDING_REVIEW_MESSAGE);
  });

  it('treats both explanations as terminal AI refusals', () => {
    for (const message of [AI_ACCESS_UNDER_REVIEW_MESSAGE, AI_ACCESS_VERIFICATION_REQUIRED_MESSAGE]) {
      expect(isAiAccessRefusal(Object.assign(new Error(message), { statusCode: 403 }))).toBe(true);
    }
  });
});
