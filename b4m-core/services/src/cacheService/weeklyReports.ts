import { ICacheRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import dayjs from 'dayjs';

const weeklyReportSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  report: z.string(),
  aiInsights: z.string().nullable(),
});

type WeeklyReport = z.infer<typeof weeklyReportSchema>;

const getCacheKey = (startDate: string, endDate: string) => `weekly-report:${startDate}:${endDate}`;

export const getWeeklyReport = async (
  params: { startDate: string; endDate: string },
  { db }: { db: { caches: ICacheRepository } }
): Promise<WeeklyReport | null> => {
  const { startDate, endDate } = secureParameters(params, z.object({ startDate: z.string(), endDate: z.string() }));
  const key = getCacheKey(startDate, endDate);

  const cache = await db.caches.findByKey(key);
  if (cache) {
    return weeklyReportSchema.parse(cache.result);
  }

  return null;
};

export const setWeeklyReport = async (
  params: WeeklyReport,
  { db }: { db: { caches: ICacheRepository } }
): Promise<WeeklyReport> => {
  const data = secureParameters(params, weeklyReportSchema);
  const key = getCacheKey(data.startDate, data.endDate);

  // Set expiry to 1 year for historical reports, 1 day for current week
  const today = dayjs().format('YYYY-MM-DD');
  const isHistoricalWeek = dayjs(data.endDate).isBefore(today, 'day');
  const expiresAt = isHistoricalWeek ? dayjs().add(1, 'year').toDate() : dayjs().add(1, 'day').toDate();

  await db.caches.createOrUpdate({
    key,
    result: data,
    expiresAt,
  });

  return data;
};
