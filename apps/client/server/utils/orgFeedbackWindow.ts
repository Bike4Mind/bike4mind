// The date window shared by the org feedback report and its drill-down list, so a cell's count
// and the rows behind it can never disagree about which days they cover.

import { dayjs, FEEDBACK_ROLLUP_MAX_WINDOW_DAYS } from '@bike4mind/common';
import { assertDateInRange, dateParam } from '@server/utils/dateParam';
import { BadRequestError } from '@server/utils/errors';
import { z } from 'zod';

// Same length as the personal rollup's FEEDBACK_ROLLUP_DEFAULT_WINDOW_DAYS
// (app/utils/feedbackRollupWindow.ts), so the two views open on the same stretch of time.
const DEFAULT_WINDOW_DAYS = 30;

// Shared by the counts route and the LLM summary route: a year of feedback is already more
// than one prompt can carry, and these routes run the $facet aggregate and its paged sibling,
// which are the most expensive reads in this area - byDay alone emits one row per day of whatever
// range the caller asks for, so leaving them unbounded while the cheaper path is capped gets it
// backwards. One constant for every feedback window, re-exported under the name these routes and
// their tests already import. This is what moved the org ceiling from a local 365 to 366 covered
// days; the comparison below did not move it.
export const MAX_WINDOW_DAYS = FEEDBACK_ROLLUP_MAX_WINDOW_DAYS;
const MAX_WINDOW_MS = MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const windowSchema = z.object({
  from: dateParam.optional(),
  to: dateParam.optional(),
});

/** The one place both window helpers below enforce ordering and the ceiling. */
function assertWindowBounds(fromDate: Date, toDate: Date): void {
  if (fromDate > toDate) throw new BadRequestError('Invalid range: from must not be after to');
  // Both bounds are inclusive, so the gap measures one instant less than the coverage it stands
  // for. `>=` is the rule FeedbackRollupQuerySchema applies to the same constant; both callers
  // below round `to` out to 23:59:59.999, so the gap never lands on the boundary and `>` would
  // read the same here - it is written this way so the two sides state one rule, not two.
  if (toDate.getTime() - fromDate.getTime() >= MAX_WINDOW_MS) {
    throw new BadRequestError(`Range must not exceed ${MAX_WINDOW_DAYS} days`);
  }
}

/**
 * Rounds the caller's `from`/`to` out to whole UTC days, defaulting to a trailing window.
 *
 * ZodError propagates to the central errorHandler (422). `dateParam` admits '' as "unset", so
 * presence is tested explicitly rather than by truthiness of a parsed date. `assertDateInRange`
 * runs AFTER the rounding: a date that parses can still be pushed out of the representable range
 * by it, and an Invalid Date reaches Mongoose as a 500. Pinned to UTC via `dayjs.utc`: the
 * aggregate's `byDay` groups in UTC and the client sends UTC day strings, so a local-time round
 * here would only agree with them when the process happens to run with `TZ=UTC`.
 */
export function resolveReportWindow(query: { from?: string; to?: string }): { from: Date; to: Date } {
  const { from, to } = windowSchema.parse({ from: query.from, to: query.to });

  const toDate = assertDateInRange(
    'to',
    to !== undefined && to !== '' ? dayjs.utc(to).endOf('day').toDate() : dayjs.utc().endOf('day').toDate()
  );
  const fromDate = assertDateInRange(
    'from',
    from !== undefined && from !== ''
      ? dayjs.utc(from).startOf('day').toDate()
      : dayjs
          .utc(toDate)
          .subtract(DEFAULT_WINDOW_DAYS - 1, 'days')
          .startOf('day')
          .toDate()
  );
  assertWindowBounds(fromDate, toDate);

  return { from: fromDate, to: toDate };
}

/**
 * Rounds an ISO-instant `startDate`/`endDate` pair out to whole UTC days, sharing the same range
 * guard and ceiling as `resolveReportWindow`. Exists so the summary route's job-keying instants and
 * the counts route's day window can never disagree about which days a window covers - both routes
 * report on the same feedback, so their idea of a window's edges has to be the same function.
 */
export function resolveInstantWindow(startDate: string, endDate: string): { from: Date; to: Date } {
  const fromDate = assertDateInRange('startDate', dayjs.utc(startDate).startOf('day').toDate());
  const toDate = assertDateInRange('endDate', dayjs.utc(endDate).endOf('day').toDate());

  assertWindowBounds(fromDate, toDate);

  return { from: fromDate, to: toDate };
}
