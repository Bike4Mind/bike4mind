import type { EvalCohort } from '@client/app/utils/verdictEval';

/**
 * Which groups of legitimate users an account belongs to, from signals the app already stores.
 * Pure; loadVerdictEval.ts loads the signals.
 */

export type CohortSignals = {
  userAgent: string | null;
  deviceTypes: string[];
  /** Another account signed up from the same IP. */
  sharedSignupIp: boolean;
  /** The account has usage from the API, an agent or the CLI. */
  apiAgentUsage: boolean;
};

const MOBILE_USER_AGENT = /Mobi|Android|iPhone|iPad/i;
const MOBILE_DEVICE_TYPES = ['Mobile', 'Tablet'];

/** The assistive cohort is never returned: no stored signal identifies it. */
export function cohortsOf(signals: CohortSignals): EvalCohort[] {
  const cohorts: EvalCohort[] = [];
  const mobile =
    (signals.userAgent !== null && MOBILE_USER_AGENT.test(signals.userAgent)) ||
    signals.deviceTypes.some(type => MOBILE_DEVICE_TYPES.includes(type));
  if (mobile) cohorts.push('mobile');
  if (signals.sharedSignupIp) cohorts.push('sharedNetwork');
  if (signals.apiAgentUsage) cohorts.push('apiAgent');
  return cohorts;
}
