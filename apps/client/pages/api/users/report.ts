import { counterService } from '@bike4mind/services';
import { CounterLog } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, UnprocessableEntityError, InternalServerError } from '@bike4mind/utils';
import { ReportQueryParamsSchema } from '../../../types/api';

const handler = baseApi().post(async (req, res) => {
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
