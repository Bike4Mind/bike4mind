import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAiConfigSchema, FEEDBACK_AI_POLICY } from '@bike4mind/common';
const mocks = vi.hoisted(() => ({ config: vi.fn(), readiness: vi.fn() }));
vi.mock('./embedAdminAi', () => ({ loadFeedbackAiConfig: mocks.config }));
vi.mock('./readiness', () => ({ getAdminAiClassReadiness: mocks.readiness }));
import { feedbackAiVisible } from './feedbackVisibility';
beforeEach(() => vi.resetAllMocks());
describe('feedback visibility readiness', () => {
  it.each(['off', 'shadow'])('hides output in %s even when replay passes', async mode => {
    mocks.config.mockResolvedValue(
      AdminAiConfigSchema.parse({ enabled: true, features: { feedbackTriage: { mode } } })
    );
    mocks.readiness.mockResolvedValue({ canRecommend: true });
    expect(await feedbackAiVisible()).toBe(false);
    expect(mocks.readiness).not.toHaveBeenCalled();
  });
  it('requires policy-specific readiness and fails closed on missing evidence or outage', async () => {
    mocks.config.mockResolvedValue(
      AdminAiConfigSchema.parse({ enabled: true, features: { feedbackTriage: { mode: 'recommend' } } })
    );
    mocks.readiness.mockResolvedValue({ canRecommend: false });
    expect(await feedbackAiVisible()).toBe(false);
    expect(mocks.readiness).toHaveBeenCalledWith({
      feature: 'feedbackTriage',
      actionClass: 'labels',
      policyVersion: FEEDBACK_AI_POLICY,
    });
    mocks.readiness.mockRejectedValueOnce(new Error('unavailable'));
    expect(await feedbackAiVisible()).toBe(false);
    mocks.readiness.mockResolvedValue({ canRecommend: true });
    expect(await feedbackAiVisible()).toBe(true);
  });
});
