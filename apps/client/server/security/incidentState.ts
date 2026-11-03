import {
  adminSettingsRepository,
  paymentAttemptRepository,
  signupGrantBudgetRepository,
  signupGrantReleaseRepository,
  SignupDomainReviewModel,
  userRepository,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';
import { Config } from '@bike4mind/server-utils/utils/config';
import { isTurnstileSecretConfigured } from '@bike4mind/server-utils/utils/turnstile';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import type {
  IncidentDefenses,
  IncidentPayments,
  IncidentQueues,
  IncidentState,
} from '@client/app/components/admin/SecurityDashboard/incidentTypes';

const DAY_MS = 24 * 60 * 60 * 1000;

const SETTING_NAMES = [
  'turnstileEnabled',
  'turnstileFailClosed',
  'signupGrantDailyBudget',
  'newAccountSpendCapDays',
  'paymentRiskAlertsEnabled',
  'paymentRiskAutoRefundEnabled',
  'paymentRiskLinkedAccountActions',
  'paymentRiskCheckoutMaxBlockedAttempts',
] as const;

function secretConfigured(): boolean | null {
  try {
    return isTurnstileSecretConfigured(Config.TURNSTILE_SECRET_KEY);
  } catch (error) {
    Logger.globalInstance.warn('Incident state: Turnstile secret could not be read', { error });
    return null;
  }
}

const positiveOrNull = (value: number) => (value > 0 ? value : null);

async function getDefenses(now: Date): Promise<IncidentDefenses> {
  let settings: Record<string, string>;
  try {
    // Uncached: an admin flipping a defense mid-incident must see it on the next refresh.
    settings = await getSettingsMap(
      { adminSettings: adminSettingsRepository },
      { skipCache: true, names: [...SETTING_NAMES] }
    );
  } catch (error) {
    Logger.globalInstance.warn('Incident state: settings read failed', { error });
    return {
      turnstile: null,
      grantBudget: null,
      newAccountSpendCapDays: null,
      paymentRisk: null,
      error: 'Settings could not be read',
    };
  }

  const defenses: IncidentDefenses = {
    turnstile: {
      enabled: getSettingsValue('turnstileEnabled', settings) ?? false,
      failClosed: getSettingsValue('turnstileFailClosed', settings) ?? false,
      secretConfigured: secretConfigured(),
    },
    grantBudget: null,
    newAccountSpendCapDays: positiveOrNull(getSettingsValue('newAccountSpendCapDays', settings) ?? 0),
    paymentRisk: {
      alertsEnabled: getSettingsValue('paymentRiskAlertsEnabled', settings) ?? false,
      autoRefundEnabled: getSettingsValue('paymentRiskAutoRefundEnabled', settings) ?? false,
      linkedAccountActions: getSettingsValue('paymentRiskLinkedAccountActions', settings) ?? false,
      checkoutMaxBlockedAttempts: positiveOrNull(
        getSettingsValue('paymentRiskCheckoutMaxBlockedAttempts', settings) ?? 0
      ),
    },
  };

  const limit = getSettingsValue('signupGrantDailyBudget', settings) ?? 0;
  if (limit > 0) {
    const day = userService.signupGrantBudgetDay(now);
    try {
      defenses.grantBudget = { limit, spentToday: await signupGrantBudgetRepository.getSpent(day), day };
    } catch (error) {
      Logger.globalInstance.warn('Incident state: grant budget read failed', { error });
      defenses.error = 'Signup grant budget spend could not be read';
    }
  }
  return defenses;
}

async function getQueues(): Promise<IncidentQueues> {
  const [riskReviews, heldGrants, domainHolds] = await Promise.allSettled([
    userRepository.countPendingRiskReviews(),
    signupGrantReleaseRepository.countHeld(),
    SignupDomainReviewModel.countDocuments({ status: 'held_pending_review' }),
  ]);
  const value = (result: PromiseSettledResult<number>) => (result.status === 'fulfilled' ? result.value : null);
  const failed = (
    [
      ['risk reviews', riskReviews],
      ['held grants', heldGrants],
      ['domain holds', domainHolds],
    ] as const
  ).filter(([, result]) => result.status === 'rejected');
  if (failed.length > 0) {
    Logger.globalInstance.warn('Incident state: queue count failed', {
      queues: failed.map(([name]) => name),
      errors: failed.map(([, result]) => (result.status === 'rejected' ? String(result.reason) : '')),
    });
  }
  return {
    riskReviewsPending: value(riskReviews),
    heldGrants: value(heldGrants),
    domainHoldsPending: value(domainHolds),
    ...(failed.length > 0 ? { error: `Could not count: ${failed.map(([name]) => name).join(', ')}` } : {}),
  };
}

async function getPayments(now: Date): Promise<IncidentPayments> {
  const [last24h, last7d] = await Promise.allSettled([
    paymentAttemptRepository.summarizeWindow(new Date(now.getTime() - DAY_MS)),
    paymentAttemptRepository.summarizeWindow(new Date(now.getTime() - 7 * DAY_MS)),
  ]);
  const failed = [last24h, last7d].filter(result => result.status === 'rejected');
  if (failed.length > 0) {
    Logger.globalInstance.warn('Incident state: payment summary failed', {
      errors: failed.map(result => (result.status === 'rejected' ? String(result.reason) : '')),
    });
  }
  return {
    last24h: last24h.status === 'fulfilled' ? last24h.value : null,
    last7d: last7d.status === 'fulfilled' ? last7d.value : null,
    ...(failed.length > 0 ? { error: 'Payment attempts could not be summarized' } : {}),
  };
}

export async function getIncidentState(now: Date = new Date()): Promise<IncidentState> {
  const [defenses, queues, payments] = await Promise.all([getDefenses(now), getQueues(), getPayments(now)]);
  return { generatedAt: now.toISOString(), defenses, queues, payments };
}
