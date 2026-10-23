import { signupProtectionRepository } from '@bike4mind/database';
import type { SignupProtection } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { postMessageToSlack } from '@server/integrations/slack/slack';

export const signupProtection: SignupProtection = {
  get repository() {
    return signupProtectionRepository;
  },
  async notifyHold(review) {
    try {
      const reviewPath = '/admin?tab=signup-domain-holds';
      const reviewLink = process.env.APP_URL ? new URL(reviewPath, process.env.APP_URL).href : reviewPath;
      const sent = await postMessageToSlack(
        [
          `Signup domain held: ${review.domain}`,
          `${review.signupCount} verified signups. ${review.reason}`,
          `Samples: ${review.sampleEmails.join(', ')}`,
          `Review: ${reviewLink}`,
        ].join('\n'),
        'SlackSecurityAlertsWebhookUrl',
        { timeoutMs: 3000 }
      );
      if (!sent) Logger.globalInstance.error('Signup domain hold alert was not delivered', { domain: review.domain });
    } catch (error) {
      Logger.globalInstance.error('Signup domain hold alert failed', error);
    }
  },
};
