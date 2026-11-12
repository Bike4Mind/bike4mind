import { FEEDBACK_AI_POLICY } from '@bike4mind/common';
import { loadFeedbackAiConfig } from './embedAdminAi';
import { getAdminAiClassReadiness } from './readiness';

export async function feedbackAiVisible(): Promise<boolean> {
  try {
    const config = await loadFeedbackAiConfig();
    if (!config.enabled || !['recommend', 'act'].includes(config.features.feedbackTriage.mode)) return false;
    return (
      await getAdminAiClassReadiness({
        feature: 'feedbackTriage',
        actionClass: 'labels',
        policyVersion: FEEDBACK_AI_POLICY,
      })
    ).canRecommend;
  } catch {
    return false;
  }
}
