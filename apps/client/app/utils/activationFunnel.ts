import type { UserFunnelStep } from './adminUsersFilter';
import { analyticsOverviewQuerySchema, type AnalyticsSignupsMode } from './analyticsOverview';

/**
 * The admin Analytics activation funnel: query and response shared by the route
 * (pages/api/admin/analytics/activation.ts), its server module (server/analytics/activationFunnelSummary.ts)
 * and the page (components/admin/Analytics).
 */
export const activationFunnelQuerySchema = analyticsOverviewQuerySchema;

export type ActivationFunnelStep = {
  step: UserFunnelStep;
  /** Judged signups that reached this step or a later one. */
  reached: number;
  /** Judged signups whose furthest step is this one: what the Users drill-down lists. */
  stoppedHere: number;
};

export type ActivationFunnel =
  | { status: 'rangeTooLong'; maxDays: number }
  | {
      status: 'ok';
      /** The Signups mode these counts were computed for; drill-downs take their verdict from it. */
      signups: AnalyticsSignupsMode;
      /** The Users list's created window, [createdFrom, createdTo). */
      window: { createdFrom: string; createdTo: string };
      steps: ActivationFunnelStep[];
      /** Counted signups in the range still too young to judge. */
      tooNew: number;
      /** Some judged signups are younger than the paid window, so the paid step may still grow. */
      paidPending: boolean;
      /** Share of judged signups that came back, in percent; null when none were judged. */
      activationRate: { value: number | null; previous: number | null };
    };
