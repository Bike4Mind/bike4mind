import { FEEDBACK_AI_POLICY } from '@bike4mind/common';
import { loadFeedbackAiConfig } from './embedAdminAi';

export async function feedbackAiVisible(): Promise<boolean> {
  try {
    const config = await loadFeedbackAiConfig();
    if (!config.enabled || !['recommend', 'act'].includes(config.features.feedbackTriage.mode)) return false;
    // Replaced by the policy-versioned operations readiness reader when available.
    return Boolean(FEEDBACK_AI_POLICY) && false;
  } catch {
    return false;
  }
}
