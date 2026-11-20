import type {
  UsagePatternSignal,
  UsagePatternSignalId,
  UsagePatternSignalsConfig,
  UsagePatternSignalsResult,
} from '@bike4mind/common';

const MS_PER_MINUTE = 60_000;

/** Stored per-user usage data the signals are computed from. */
export interface UsagePatternFacts {
  /** Distinct requests in the API-only lookback made with an API key. */
  apiKeyRequests: number;
  /** Distinct requests in the same lookback made from a signed-in session (web, CLI or desktop). */
  sessionRequests: number;
  /** Start times of the most recent distinct requests in the lookback window, any order. */
  requestTimes: Date[];
  /** Credit balance reads in the lookback window. */
  creditPolls: number;
  /** Distinct completion requests in the lookback window. */
  completions: number;
  emailVerifiedAt: Date | null;
  firstApiKeyAt: Date | null;
  /** The fresh-account sequence; null when the account is older than scriptedDrainFreshHours. */
  grantDrain?: GrantDrainFacts | null;
}

/** What a fresh account did between signup and logout, for the scriptedGrantDrain signal. */
export interface GrantDrainFacts {
  signedUpAt: Date;
  /** When 2FA was set up, if it is on. */
  mfaEnabledAt: Date | null;
  /** The activity unlock of the signup grant (ledger reason signup_unlock:activity). */
  activityUnlockAt: Date | null;
  /** Credits the signup grants paid (the tranche and every unlock), positive. */
  grantedCredits: number;
  /** The single most expensive turn since signup; credits positive. */
  largestTurn: { at: Date; credits: number } | null;
  /** Usage-charged turns since signup. */
  turns: number;
  /** Explicit logout of the newest sign-in. */
  loggedOutAt: Date | null;
}

const signal = (
  id: UsagePatternSignalId,
  config: UsagePatternSignalsConfig,
  value: number | null,
  triggered: boolean,
  explanation: string
): UsagePatternSignal => ({ id, value, triggered, weight: config.weights[id], explanation });

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

/** Standard deviation over mean; 0 when every value is 0, null for an empty list. */
export function coefficientOfVariation(values: number[]): number | null {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function formatDuration(ms: number): string {
  if (ms < MS_PER_MINUTE) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * MS_PER_MINUTE) return `${Math.round(ms / MS_PER_MINUTE)}m`;
  return `${(ms / (60 * MS_PER_MINUTE)).toFixed(1)}h`;
}

export function apiOnlyUsageSignal(
  facts: Pick<UsagePatternFacts, 'apiKeyRequests' | 'sessionRequests'>,
  config: UsagePatternSignalsConfig
): UsagePatternSignal {
  const { apiKeyRequests, sessionRequests } = facts;
  const total = apiKeyRequests + sessionRequests;
  const period = `in the last ${config.apiOnlyLookbackDays} days`;
  if (total === 0) return signal('apiOnlyUsage', config, null, false, `No completions ${period}`);
  const share = apiKeyRequests / total;
  const triggered = apiKeyRequests >= config.apiOnlyMinRequests && share >= config.apiOnlyMinShare;
  const explanation =
    sessionRequests === 0
      ? `All ${total} completions ${period} were made with an API key, none from a signed-in session`
      : `${percent(share)} of ${total} completions ${period} were made with an API key`;
  return signal('apiOnlyUsage', config, share, triggered, explanation);
}

export function regularCadenceSignal(requestTimes: Date[], config: UsagePatternSignalsConfig): UsagePatternSignal {
  const times = requestTimes
    .map(t => t.getTime())
    .sort((a, b) => a - b)
    .slice(-config.cadenceSampleSize);
  if (times.length < config.cadenceSampleSize) {
    return signal(
      'regularCadence',
      config,
      null,
      false,
      `${times.length} recent requests, too few to measure request timing`
    );
  }
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const variation = coefficientOfVariation(gaps) ?? 0;
  const meanGap = gaps.reduce((sum, g) => sum + g, 0) / gaps.length;
  return signal(
    'regularCadence',
    config,
    Math.round(variation * 1000) / 1000,
    variation <= config.cadenceMaxVariation,
    `Gaps between the last ${times.length} requests average ${formatDuration(meanGap)} and vary by ${percent(variation)}`
  );
}

export function creditPollingSignal(
  facts: Pick<UsagePatternFacts, 'creditPolls' | 'completions'>,
  config: UsagePatternSignalsConfig
): UsagePatternSignal {
  const { creditPolls, completions } = facts;
  // With no completions every poll counts against one, so polling alone can still trigger.
  const ratio = creditPolls / Math.max(completions, 1);
  return signal(
    'creditPolling',
    config,
    Math.round(ratio * 100) / 100,
    creditPolls >= config.creditPollMinCount && ratio >= config.creditPollMinPerCompletion,
    `${creditPolls} credit balance checks and ${completions} completions in the last ${config.lookbackDays} days`
  );
}

export function quickApiKeySignal(
  facts: Pick<UsagePatternFacts, 'emailVerifiedAt' | 'firstApiKeyAt'>,
  config: UsagePatternSignalsConfig
): UsagePatternSignal {
  const { emailVerifiedAt, firstApiKeyAt } = facts;
  if (!firstApiKeyAt) return signal('quickApiKey', config, null, false, 'No API key created');
  if (!emailVerifiedAt) return signal('quickApiKey', config, null, false, 'Email address not verified');
  const minutes = (firstApiKeyAt.getTime() - emailVerifiedAt.getTime()) / MS_PER_MINUTE;
  const explanation =
    minutes < 0
      ? `First API key created ${Math.round(-minutes)} minutes before email verification`
      : `First API key created ${Math.round(minutes)} minutes after email verification`;
  // An early key counts only within a bounded window, so long-standing accounts verified late do not trigger.
  const earliest = -config.quickApiKeyMaxDaysBeforeVerification * 24 * 60;
  return signal(
    'quickApiKey',
    config,
    Math.round(minutes * 10) / 10,
    minutes >= earliest && minutes <= config.quickApiKeyMinutes,
    explanation
  );
}

/**
 * The scripted free-credit farm sequence on a fresh account: signup, 2FA on and the activity grant
 * unlocked, one turn that spends most of the signup grants, then logout, all within minutes. Every
 * step is required: an ordinary new user may run one large turn, but rarely turns on 2FA first and
 * logs out straight after. The value is the minutes from signup to logout.
 */
export function scriptedGrantDrainSignal(
  facts: Pick<UsagePatternFacts, 'grantDrain'>,
  config: UsagePatternSignalsConfig
): UsagePatternSignal {
  const drain = facts.grantDrain;
  if (!drain)
    return signal(
      'scriptedGrantDrain',
      config,
      null,
      false,
      `Account older than ${config.scriptedDrainFreshHours} hours`
    );
  const { signedUpAt, mfaEnabledAt, activityUnlockAt, largestTurn, loggedOutAt } = drain;
  if (!largestTurn || !loggedOutAt) {
    return signal('scriptedGrantDrain', config, null, false, 'No completed turn followed by a logout');
  }
  const minutes = (loggedOutAt.getTime() - signedUpAt.getTime()) / MS_PER_MINUTE;
  const share = drain.grantedCredits > 0 ? largestTurn.credits / drain.grantedCredits : 0;
  const setupDone = (at: Date | null) => at !== null && at >= signedUpAt && at <= largestTurn.at;
  const steps = [
    setupDone(mfaEnabledAt) ? '2FA on' : null,
    setupDone(activityUnlockAt) ? 'activity grant unlocked' : null,
  ].filter((step): step is string => step !== null);
  const triggered =
    steps.length === 2 &&
    largestTurn.at <= loggedOutAt &&
    minutes >= 0 &&
    minutes <= config.scriptedDrainMaxMinutes &&
    share >= config.scriptedDrainMinShare &&
    drain.turns <= config.scriptedDrainMaxTurns;
  const explanation =
    `Signup, ${steps.length > 0 ? `${steps.join(' and ')}, ` : ''}${drain.turns} turn${drain.turns === 1 ? '' : 's'} ` +
    `(largest ${percent(share)} of the ${drain.grantedCredits} signup credits), then logout ${formatDuration(minutes * MS_PER_MINUTE)} after signup`;
  return signal('scriptedGrantDrain', config, Math.round(minutes * 10) / 10, triggered, explanation);
}

/**
 * All usage pattern signals for one user plus their weighted score. Pure and read-only: it
 * describes the account for a reviewer and decides nothing on its own.
 */
export function computeUsagePatternSignals(
  facts: UsagePatternFacts,
  config: UsagePatternSignalsConfig
): UsagePatternSignalsResult {
  const signals = [
    apiOnlyUsageSignal(facts, config),
    regularCadenceSignal(facts.requestTimes, config),
    creditPollingSignal(facts, config),
    quickApiKeySignal(facts, config),
    scriptedGrantDrainSignal(facts, config),
  ];
  const score = Math.min(
    100,
    signals.reduce((sum, s) => sum + (s.triggered ? s.weight : 0), 0)
  );
  return { signals, score, needsReview: score >= config.reviewThreshold };
}
