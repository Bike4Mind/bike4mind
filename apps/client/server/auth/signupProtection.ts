import { Resource } from 'sst';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { signupGrantBudgetRepository, signupProtectionRepository } from '@bike4mind/database';
import type { SignupProtection } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { escapeSlackText } from '@bike4mind/services';
import { postMessageToSlackWithOutcome } from '@bike4mind/server-utils/integrations/slack/slack';
import { emitMetrics } from '@bike4mind/server-utils/utils/cloudwatch';

/** Shared with the refresh job's SourceFailures metric (apps/workers/src/cron/disposableDomainRefresh.ts). */
const DISPOSABLE_DOMAINS_NAMESPACE = 'Lumina5/DisposableDomains';

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
    // Rejecting on an undelivered post keeps the caller from marking the day alerted.
    const outcome = await postMessageToSlackWithOutcome(message, 'SlackLiveopsWebhookUrl', { timeoutMs: 3000 });
    if (outcome === 'failed') throw new Error('Signup grant config alert was not delivered');
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
  // One datum per matching source, so a list that starts refusing real users shows as its own series.
  async recordDisposableRefusal({ sources }) {
    await emitMetrics(
      DISPOSABLE_DOMAINS_NAMESPACE,
      sources.map(source => ({
        name: 'SignupRefusals',
        value: 1,
        dimensions: { Stage: Resource.App.stage, Source: source },
        unit: StandardUnit.Count,
      }))
    );
  },
};
