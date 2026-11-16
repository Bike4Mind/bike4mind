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
export type AcquisitionTouch = AcquisitionTouchKind;
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

export type AcquisitionRow = {
  kind: AcquisitionRowKind;
  /** `source|medium|campaign`, lowercased; the fixed unattributed/other keys for those rows. */
  key: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  signups: number;
};

export type AcquisitionConversion =
  | { status: 'rangeTooLong'; maxDays: number }
  | {
      status: 'ok';
      signups: AnalyticsSignupsMode;
      touch: AcquisitionTouch;
      /** The Users list's created window, [createdFrom, createdTo). */
      window: { createdFrom: string; createdTo: string };
      /** Share of signups carrying a touch; `pct` is null when there are no signups. */
      coverage: { signups: number; attributed: number; pct: number | null };
      rows: AcquisitionRow[];
      /** More than ACQUISITION_TOP_ROWS touch rows existed; the rest are in the `other` row. */
      truncated: boolean;
    };
