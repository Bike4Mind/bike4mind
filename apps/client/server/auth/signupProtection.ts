import { Resource } from 'sst';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import {
  heldCreditRewardRepository,
  signupGrantBudgetRepository,
  signupProtectionRepository,
} from '@bike4mind/database';
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
    get heldRewards() {
      return heldCreditRewardRepository;
    },
    async notify(alert) {
      try {
        const pool = `${alert.pool === 'signup' ? 'Signup' : 'Trickle'} pool`;
        const paid = `${alert.spent.toLocaleString('en-US')} of ${alert.budget.toLocaleString('en-US')} credits paid`;
        const outcome = await postMessageToSlackWithOutcome(
          alert.threshold === 'missing'
            ? `${pool} setting is missing or invalid for ${alert.day}; its free grants are paused until it is set.`
            : alert.threshold === 100
              ? `${pool} exhausted for ${alert.day}: ${paid}; new grants are held.`
              : `${pool} at ${alert.threshold}% for ${alert.day}: ${paid}.`,
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
