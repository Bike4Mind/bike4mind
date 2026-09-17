// The date window shared by the org feedback report and its drill-down list, so a cell's count
// and the rows behind it can never disagree about which days they cover.

import { dayjs } from '@bike4mind/common';
import { assertDateInRange, dateParam } from '@server/utils/dateParam';
import { BadRequestError } from '@server/utils/errors';
import { z } from 'zod';

const DEFAULT_WINDOW_DAYS = 30;

const windowSchema = z.object({
  from: dateParam.optional(),
  to: dateParam.optional(),
});

/**
 * Rounds the caller's `from`/`to` out to whole days, defaulting to a trailing window.
 *
 * ZodError propagates to the central errorHandler (422). `dateParam` admits '' as "unset", so
 * presence is tested explicitly rather than by truthiness of a parsed date. `assertDateInRange`
 * runs AFTER the rounding: a date that parses can still be pushed out of the representable range
 * by it, and an Invalid Date reaches Mongoose as a 500.
 */
export function resolveReportWindow(query: { from?: string; to?: string }): { from: Date; to: Date } {
  const { from, to } = windowSchema.parse({ from: query.from, to: query.to });

  const toDate = assertDateInRange(
    'to',
    to !== undefined && to !== '' ? dayjs(to).endOf('day').toDate() : dayjs().endOf('day').toDate()
  );
  const fromDate = assertDateInRange(
    'from',
    from !== undefined && from !== ''
      ? dayjs(from).startOf('day').toDate()
      : dayjs(toDate).subtract(DEFAULT_WINDOW_DAYS, 'days').startOf('day').toDate()
  );
  if (fromDate > toDate) throw new BadRequestError('Invalid range: from must not be after to');

  return { from: fromDate, to: toDate };
}
