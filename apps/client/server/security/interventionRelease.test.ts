import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoContainmentDecisionItem } from '@bike4mind/common';

const h = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ userRepository: {}, autoContainmentDecisionRepository: {} }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.record }));

import {
  releaseForLegitimateVerdict,
  releaseInterventionDecision,
  type InterventionReleaseDeps,
} from './interventionRelease';

const NOW = new Date('2026-11-24T10:00:00Z');

const decision = (over: Partial<AutoContainmentDecisionItem> = {}): AutoContainmentDecisionItem => ({
  id: 'decision-1',
  detectionId: 'detection-1',
  revision: 0,
  assessmentId: 'assessment-1',
  mode: 'enforce',
  outcome: 'intervened',
  userIds: ['u1', 'u2'],
  confidence: 0.95,
  reason: 'Automated review (policy v1)',
  batchId: null,
  error: null,
  decidedAt: NOW,
  tier: 'review',
  policyVersion: 1,
  scope: 'account',
  expiresAt: new Date(NOW.getTime() + 3_600_000),
  releaseCondition: null,
  releasedAt: null,
  releasedBy: null,
  releaseReason: null,
  ...over,
});

let deps: {
  users: { releaseInterventionHold: ReturnType<typeof vi.fn>; hasUnreleasedInterventionHold: ReturnType<typeof vi.fn> };
  decisions: { release: ReturnType<typeof vi.fn>; listForDetection: ReturnType<typeof vi.fn> };
};
const asDeps = () => deps as unknown as InterventionReleaseDeps;
const input = { by: 'admin-1', reason: 'cleared', now: NOW };

beforeEach(() => {
  deps = {
    users: {
      releaseInterventionHold: vi.fn().mockResolvedValue(true),
      hasUnreleasedInterventionHold: vi.fn().mockResolvedValue(false),
    },
    decisions: { release: vi.fn().mockResolvedValue(null), listForDetection: vi.fn().mockResolvedValue([]) },
  };
});

describe('releaseInterventionDecision', () => {
  it('releases each named account and then the decision once no hold remains', async () => {
    const released = await releaseInterventionDecision(decision(), { ...input, condition: 'admin_release' }, asDeps());

    expect(released).toEqual(['u1', 'u2']);
    expect(deps.users.releaseInterventionHold).toHaveBeenCalledWith('u1', 'decision-1', { by: 'admin-1', now: NOW });
    expect(deps.decisions.release).toHaveBeenCalledWith('decision-1', {
      by: 'admin-1',
      reason: 'cleared',
      condition: 'admin_release',
      now: NOW,
    });
  });

  it('keeps the decision applied while another account still carries its hold', async () => {
    deps.users.hasUnreleasedInterventionHold.mockResolvedValue(true);

    const released = await releaseInterventionDecision(
      decision(),
      { ...input, condition: 'admin_release', userIds: ['u1', 'not-named'] },
      asDeps()
    );

    expect(released).toEqual(['u1']);
    expect(deps.users.releaseInterventionHold).toHaveBeenCalledTimes(1);
    expect(deps.decisions.release).not.toHaveBeenCalled();
  });

  it('never releases a Contain decision', async () => {
    const released = await releaseInterventionDecision(
      decision({ tier: 'contain', outcome: 'contained' }),
      { ...input, condition: 'admin_release' },
      asDeps()
    );

    expect(released).toEqual([]);
    expect(deps.users.releaseInterventionHold).not.toHaveBeenCalled();
    expect(deps.decisions.release).not.toHaveBeenCalled();
  });
});

describe('releaseForLegitimateVerdict', () => {
  it('releases only applied graduated decisions of the detection', async () => {
    deps.decisions.listForDetection.mockResolvedValue([
      decision({ id: 'applied' }),
      decision({ id: 'shadow', outcome: 'would_intervene' }),
      decision({ id: 'contained', tier: 'contain', outcome: 'contained' }),
      decision({ id: 'gone', outcome: 'released' }),
    ]);

    const results = await releaseForLegitimateVerdict('detection-1', input, asDeps());

    expect(results).toEqual([{ decisionId: 'applied', userIds: ['u1', 'u2'] }]);
    expect(deps.decisions.release).toHaveBeenCalledWith(
      'applied',
      expect.objectContaining({ condition: 'legitimate_verdict' })
    );
  });
});
