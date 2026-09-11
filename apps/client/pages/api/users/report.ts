import { ApiKeyScope, Permission } from '@bike4mind/common';
import { counterService } from '@bike4mind/services';
import { CounterLog } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, UnprocessableEntityError, InternalServerError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { ReportQueryParamsSchema } from '../../../types/api';

// Same two-part gate as the sibling users/counterLogs.ts: this report aggregates every user's
// activity, so the scope gate keeps a narrow API key narrow and the ability check covers JWTs.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(async (req, res) => {
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
