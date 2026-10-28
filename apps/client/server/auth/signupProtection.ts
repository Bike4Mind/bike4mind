import { signupProtectionRepository } from '@bike4mind/database';
import type { SignupProtection } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { escapeSlackText } from '@bike4mind/services';
import { postMessageToSlackWithOutcome } from '@server/integrations/slack/slack';

export const signupProtection: SignupProtection = {
  get repository() {
    return signupProtectionRepository;
  },
  async notifyHold(review) {
    try {
      const reviewPath = '/admin?tab=signup-domain-holds';
      const reviewLink = process.env.APP_URL ? new URL(reviewPath, process.env.APP_URL).href : reviewPath;
      const outcome = await postMessageToSlackWithOutcome(
        [
          `Signup domain held: ${escapeSlackText(review.domain)}`,
          `${review.signupCount} verified signups. ${escapeSlackText(review.reason)}`,
          `Samples: ${review.sampleEmails.map(escapeSlackText).join(', ')}`,
          `Review: ${reviewLink}`,
        ].join('\n'),
        'SlackSecurityAlertsWebhookUrl',
        { timeoutMs: 3000 }
      );
      // 'unconfigured' means security alerts are turned off; the Slack module already warned about it.
      if (outcome === 'failed') {
        Logger.globalInstance.error('Signup domain hold alert was not delivered', { domain: review.domain });
      }
    } catch (error) {
      Logger.globalInstance.error('Signup domain hold alert failed', error);
    }
  },
};
