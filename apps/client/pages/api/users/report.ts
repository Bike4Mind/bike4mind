import { ApiKeyScope, Permission } from '@bike4mind/common';
import { counterService } from '@bike4mind/services';
import { CounterLog } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { BadRequestError, UnprocessableEntityError, InternalServerError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { ReportQueryParamsSchema } from '../../../types/api';

const ONE_MINUTE_MS = 60 * 1000;
// Nothing in the app calls this one: the only callers are admin API keys and hand-driven
// requests (it is listed in the in-app API reference and nothing under app/ fetches it).
// One request is one day - ReportQueryParamsSchema takes a
// single `date` - and the report is uncached, joining a user onto every counter log for that
// date, so the only multi-request pattern is a walk over consecutive dates. 5/min covers a work
// week walked inside one minute; a longer backfill has to honor the Retry-After this returns.
export const DAILY_REPORT_RATE_LIMIT = 5;

// Same two-part gate as the sibling users/counterLogs.ts: this report aggregates every user's
// activity, so the scope gate keeps a narrow API key narrow and the ability check covers JWTs.
// Neither bounds how often an authorized admin can ask for it; `rateLimit` does, chained after
// baseApi's auth so it keys on `req.user.id` rather than the client IP.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: DAILY_REPORT_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'users-daily-report' }))
  .post(async (req, res) => {
    if (!req.ability?.can(Permission.read, CounterLog)) {
      throw new ForbiddenError('Unauthorized');
    }

    const queryValidation = ReportQueryParamsSchema.safeParse(req.query);

    if (!queryValidation.success) {
      throw new BadRequestError('Invalid query parameters', {
        errors: queryValidation.error.issues.map(err => ({
          field: err.path.join('.'),
          message: err.message,
        })),
      });
    }

    const { date } = queryValidation.data;

    try {
      const report = await counterService.generateDailyReport(
        { date },
        { db: { counterLogs: CounterLog }, logger: req.logger }
      );

      if (!report) {
        throw new UnprocessableEntityError('No data available for the specified date');
      }

      res.status(200).json(report);
    } catch (error) {
      req.logger.error('Error generating daily report', { date, error });

      // Re-throw known errors
      if (error instanceof BadRequestError || error instanceof UnprocessableEntityError) {
        throw error;
      }

      // Wrap unknown errors
      throw new InternalServerError('Failed to generate report. Please try again later.');
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
