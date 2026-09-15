import { z } from 'zod';
import { getCounterTotalsForLast24Hours } from './getAllCounterFrom24Hours';
import { CounterMetricsResponse } from './types';
import { Logger } from '@bike4mind/observability';
import { secureParameters } from '@bike4mind/utils';
import { dayjs } from '@bike4mind/common';
import { ICounterLog, ICounterLogRepository, IUserDocument } from '@bike4mind/common';

const generateDailyReportSchema = z.object({
  date: z.string(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

type GenerateDailyReportParameters = z.infer<typeof generateDailyReportSchema>;

interface GenerateDailyReportAdapters {
  db: {
    counterLogs: ICounterLogRepository;
  };
  logger: Logger;
}

export async function generateDailyReport(
  parameters: GenerateDailyReportParameters,
  adapters: GenerateDailyReportAdapters
): Promise<CounterMetricsResponse> {
  const { db, logger } = adapters;
  const { date, startDate, endDate } = secureParameters(parameters, generateDailyReportSchema);

  logger.info('Generating report', {
    date,
    startDate,
    endDate,
    isWeeklyReport: !!(startDate && endDate),
  });

  // Weekly reports pass a date range; daily reports a single date.
  const data = await getCounterTotalsForLast24Hours(
    startDate && endDate ? { date: startDate, endDate } : { date },
    adapters
  );

  let rawLogs;
  if (startDate && endDate) {
    logger.info('Fetching logs for weekly report', { startDate, endDate });
    rawLogs = await db.counterLogs.findAllWithUserByDateRange(startDate, endDate);
  } else {
    logger.info('Fetching logs for daily report', { date });
    rawLogs = await db.counterLogs.findAllWithUserByDate(date);
  }

  logger.info('Found logs', { count: rawLogs.length });

  const logs = rawLogs.map((log: ICounterLog & { user: IUserDocument }) => ({
    date: dayjs(log.datetime).format('YYYY-MM-DD'),
    counterName: log.counterName,
    totalValue: log.counterValue || 0,
    count: 1,
    userId: log.userId,
    userEmail: log.user?.email || '',
  }));

  return {
    ...data,
    logs,
  };
}
