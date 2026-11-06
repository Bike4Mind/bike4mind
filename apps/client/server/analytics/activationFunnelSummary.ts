import {
  USER_FUNNEL_STEP_FILTERS,
  COHORT_WINDOW_MAX_DAYS,
  type UserFunnelStep,
} from '@client/app/utils/adminUsersFilter';
import type { ActivationFunnel, ActivationFunnelStep } from '@client/app/utils/activationFunnel';
import type { AnalyticsOverviewQuery } from '@client/app/utils/analyticsOverview';
import { GatewayTimeoutError } from '@bike4mind/common';
import { classifyFunnelCohort, COHORT_MAX_TIME_MS, paidWindowOpen, type FunnelMember } from './activationFunnel';
import { daysBetween, resolveOverviewWindow } from './analyticsOverview';
import { shiftDay } from './analyticsRollup';
import { signupVerdictUserIds } from './realSignup';

// ms. The whole request, kept well inside the 60s API Lambda so a slow funnel fails with a handled 504.
const FUNNEL_BUDGET_MS = 40_000;

/** Cumulative bars: `reached` counts a member at their furthest step and every step before it. */
export function summarizeFunnel(members: readonly { step: UserFunnelStep }[]): ActivationFunnelStep[] {
  return USER_FUNNEL_STEP_FILTERS.map((step, index) => ({
    step,
    reached: members.filter(member => USER_FUNNEL_STEP_FILTERS.indexOf(member.step) >= index).length,
    stoppedHere: members.filter(member => member.step === step).length,
  }));
}

const activationRate = (steps: ActivationFunnelStep[]) =>
  steps[0].reached === 0 ? null : (steps[2].reached / steps[0].reached) * 100;

async function judgedMembers(
  { from, to }: { from: string; to: string },
  legitOnly: boolean,
  now: Date,
  expiresAt: number
): Promise<{ members: FunnelMember[]; tooNew: number; createdFrom: string; createdTo: string }> {
  const createdFrom = `${from}T00:00:00.000Z`;
  const createdTo = `${shiftDay(to, 1)}T00:00:00.000Z`;
  const window = { start: new Date(createdFrom), end: new Date(createdTo) };
  const [cohort, legitIds] = await Promise.all([
    classifyFunnelCohort(window, { now, deadlineMs: COHORT_MAX_TIME_MS, withTooNew: true, expiresAt }),
    legitOnly
      ? signupVerdictUserIds(
          { ...window, verdict: 'legit' },
          { deadlineMs: Math.max(1, Math.min(COHORT_MAX_TIME_MS, expiresAt - Date.now())) }
        )
      : undefined,
  ]);
  if (!legitIds) return { members: cohort.members, tooNew: cohort.tooNewIds.length, createdFrom, createdTo };
  // Same intersection the users list makes for verdict=legit&funnelStep=X.
  const legit = new Set(legitIds);
  const members = cohort.members.filter(member => legit.has(member.id));
  return { members, tooNew: cohort.tooNewIds.filter(id => legit.has(id)).length, createdFrom, createdTo };
}

/** Rejects with a handled 504 once `expiresAt` (epoch ms) passes; the queries' own time limits stop the reads. */
async function withinBudget<T>(work: Promise<T>, expiresAt: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new GatewayTimeoutError('The funnel took too long.')),
      Math.max(0, expiresAt - Date.now())
    );
  });
  return Promise.race([work, timedOut]).finally(() => clearTimeout(timer));
}

/**
 * The activation funnel for the query's range, resolved with the same classifier the Users drill-down uses
 * so a step's "stopped here" count equals the size of its list. Ranges longer than the drill-down accepts
 * are not computed.
 */
export async function getActivationFunnel(query: AnalyticsOverviewQuery, now: Date): Promise<ActivationFunnel> {
  const window = resolveOverviewWindow(query, now);
  if (daysBetween(window.from, window.to).length > COHORT_WINDOW_MAX_DAYS) {
    return { status: 'rangeTooLong', maxDays: COHORT_WINDOW_MAX_DAYS };
  }
  const legitOnly = query.signups === 'legit';
  const expiresAt = Date.now() + FUNNEL_BUDGET_MS;
  const current = await withinBudget(judgedMembers(window, legitOnly, now, expiresAt), expiresAt);
  // Only the tile's comparison needs the previous period: it runs once the funnel has loaded, in what is left
  // of the budget, and its failure must not hide the funnel.
  const previous = window.previous
    ? await withinBudget(judgedMembers(window.previous, legitOnly, now, expiresAt), expiresAt).catch(error => {
        console.warn('activation funnel: previous-period comparison failed', error);
        return undefined;
      })
    : undefined;
  const steps = summarizeFunnel(current.members);
  return {
    status: 'ok',
    signups: query.signups,
    window: { createdFrom: current.createdFrom, createdTo: current.createdTo },
    steps,
    tooNew: current.tooNew,
    paidPending: current.members.some(member => paidWindowOpen(member.signupAt, now)),
    activationRate: {
      value: activationRate(steps),
      previous: previous ? activationRate(summarizeFunnel(previous.members)) : null,
    },
  };
}
