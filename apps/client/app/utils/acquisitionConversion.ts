import { z } from 'zod';
import {
  ACQUISITION_NONE,
  ACQUISITION_UNATTRIBUTED_KEY,
  type AcquisitionTouchKind,
} from '@bike4mind/server-utils/app/utils/acquisitionTouch';
import { analyticsOverviewQuerySchema, type AnalyticsSignupsMode } from './analyticsOverview';

/**
 * The admin Analytics acquisition & conversion section: query and response shared by its server module
 * (server/analytics/acquisitionConversionSummary.ts) and the page (components/admin/Analytics).
 */

export const ACQUISITION_TOUCHES = ['first', 'last'] as const satisfies readonly AcquisitionTouchKind[];
/** Days after signup a first payment may land and still count as converting. */
export const ACQUISITION_CONVERSION_WINDOWS = ['7', '30', '90'] as const;
/** Days after the first payment over which repeat purchases and retention are judged. */
export const ACQUISITION_FOLLOW_UPS = ['30', '60', '90'] as const;

export const acquisitionQuerySchema = analyticsOverviewQuerySchema.and(
  z.object({
    touch: z.enum(ACQUISITION_TOUCHES).default('first'),
    window: z.enum(ACQUISITION_CONVERSION_WINDOWS).default('30'),
    followUp: z.enum(ACQUISITION_FOLLOW_UPS).default('90'),
  })
);
export type AcquisitionQuery = z.infer<typeof acquisitionQuerySchema>;

/** Most source/medium/campaign rows returned; the rest are summed into one `other` row. */
export const ACQUISITION_TOP_ROWS = 50;
export const ACQUISITION_OTHER_KEY = 'other';
export { ACQUISITION_NONE, ACQUISITION_UNATTRIBUTED_KEY };
// Consent is not recorded per user, so a signup without a touch may have declined or never been tagged.
export const ACQUISITION_UNATTRIBUTED_LABEL = 'Unattributed / consent unknown';

export type AcquisitionRowKind = 'touch' | 'unattributed' | 'other';

/**
 * Conversion counts for a group of signups. Conversion columns count only signups whose conversion window
 * has closed; follow-up columns count only converted buyers whose follow-up period has passed.
 */
export type AcquisitionMetrics = {
  signups: number;
  /** Signups old enough for the activation funnel to judge their first week (its minimum age). */
  activationSignups: number;
  /** Judged signups with AI activity in their first week, by the activation funnel's rules. */
  firstAction: number;
  /** Judged signups active again on a later day of that first week. */
  cameBack: number;
  /** Signups whose conversion window has closed. */
  matureSignups: number;
  /** Mature signups with a personal payment inside the window; split by first payment kind below. */
  converted: number;
  subscriptionFirst: number;
  creditFirst: number;
  /** Converted buyers who paid both kinds inside the window (already inside the two counts above). */
  both: number;
  /** Signups still inside their window who have already paid; not part of the rate. */
  provisionalConverted: number;
  /** Some signups are still inside their window, so the rate may rise. */
  provisional: boolean;
  /** converted / matureSignups * 100, null with no mature signups. */
  conversionPct: number | null;
  /** Mature signups whose owned organization was paid for inside the window. */
  orgBuyers: number;
  /** Converted buyers still holding at least one payment that was not refunded or disputed. */
  retained: number;
  /** Converted buyers whose follow-up period has passed. */
  followUpBuyers: number;
  /** Converted buyers still inside their follow-up period. */
  followUpPending: number;
  /** Follow-up buyers with two or more kept credit purchases inside the follow-up. */
  repeatCredit: number;
  /** Follow-up buyers whose subscription's first renewal fell inside the follow-up. */
  renewalDue: number;
  renewed: number;
  /** Follow-up subscribers whose renewal cannot be derived (no interval or period start recorded). */
  renewalUnavailable: number;
};

export type AcquisitionRow = AcquisitionMetrics & {
  kind: AcquisitionRowKind;
  /** `source|medium|campaign`, lowercased; the fixed unattributed/other keys for those rows. */
  key: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
};

export type AcquisitionConversion =
  | { status: 'rangeTooLong'; maxDays: number }
  | {
      status: 'ok';
      signups: AnalyticsSignupsMode;
      touch: AcquisitionTouchKind;
      /** The Users list's created window, [createdFrom, createdTo). */
      window: { createdFrom: string; createdTo: string };
      /** Share of signups carrying a touch; `pct` is null when there are no signups. */
      coverage: { signups: number; attributed: number; pct: number | null };
      conversionWindowDays: number;
      followUpDays: number;
      /** Renewals are derived from each subscription's current state, not from an invoice history. */
      renewalBasis: 'subscription-state';
      totals: AcquisitionMetrics;
      rows: AcquisitionRow[];
      /** More than ACQUISITION_TOP_ROWS touch rows existed; the rest are in the `other` row. */
      truncated: boolean;
    };
