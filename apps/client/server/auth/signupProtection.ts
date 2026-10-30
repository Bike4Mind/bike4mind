import { signupGrantBudgetRepository, signupProtectionRepository } from '@bike4mind/database';
import type { SignupProtection } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { escapeSlackText } from '@bike4mind/services';
import { postMessageToSlackWithOutcome } from '@server/integrations/slack/slack';

export const signupProtection: SignupProtection = {
  get repository() {
    return signupProtectionRepository;
  },
  grantBudget: {
    get repository() {
      return signupGrantBudgetRepository;
    },
    async notify(alert) {
      try {
        const outcome = await postMessageToSlackWithOutcome(
          alert.threshold === 100
            ? `Signup grant budget exhausted for ${alert.day}: ${alert.spent.toLocaleString('en-US')} of ${alert.budget.toLocaleString('en-US')} credits paid; new grants are held.`
            : `Signup grant budget at ${alert.threshold}% for ${alert.day}: ${alert.spent.toLocaleString('en-US')} of ${alert.budget.toLocaleString('en-US')} credits paid.`,
          'SlackSecurityAlertsWebhookUrl',
          { timeoutMs: 3000 }
        );
        if (outcome === 'failed') {
          Logger.globalInstance.error('Signup grant budget alert was not delivered', { threshold: alert.threshold });
        }
      } catch (error) {
        Logger.globalInstance.error('Signup grant budget alert failed', error);
      }
    },
  },
  async notifyConfig(alert) {
    const message = `Signup grant drip cap (${alert.setting}) is unset; paying from the default of ${alert.fallback.toLocaleString('en-US')} credits. Set it in Admin Settings.`;
    Logger.globalInstance.error(message);
    try {
      const outcome = await postMessageToSlackWithOutcome(message, 'SlackSecurityAlertsWebhookUrl', {
        timeoutMs: 3000,
      });
      if (outcome === 'failed') Logger.globalInstance.error('Signup grant config alert was not delivered');
    } catch (error) {
      Logger.globalInstance.error('Signup grant config alert failed', error);
    }
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
