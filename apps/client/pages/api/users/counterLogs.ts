import { ApiKeyScope, Permission, dayjs, type CompletionSource } from '@bike4mind/common';
import {
  CounterLog,
  DailyReport,
  dailyReportRepository,
  weeklyReportRepository,
  cacheRepository,
  counterLogRepository,
  convertPipelineForDocumentDB,
  executeFacetCompatible,
  User,
} from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { Logger } from '@bike4mind/observability';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import { counterService } from '@bike4mind/services';
import { getEffectiveApiKeyByBackend, OperationsModelService } from '@client/services/operationsModelService';
import { z } from 'zod';
import { Request } from 'express';
import qs from 'qs';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { sendMaybeGzip } from '@server/utils/sendMaybeGzip';
import {
  buildUserActivityPipeline,
  parseMetadataFilters,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '@server/analytics/userActivityQuery';
import {
  asWindow,
  buildWindow,
  sliceWindow,
  windowCoversPage,
  windowRowsFor,
} from '@server/analytics/userActivityCache';

dayjs.extend(isSameOrBefore);

// Lambda gives this route a 60s budget; leave headroom for the response to serialize/gzip
// after the DB call returns rather than let a slow query eat the whole timeout. Deliberately
// larger than the 20s used by the overwatch services - this route's aggregation is heavier and
// its Lambda budget is 60s, so it is sized to this route rather than copied from elsewhere.
const AGGREGATION_MAX_TIME_MS = 45000;

/**
 * Both dates are interpolated into `new Date(`${date}T00:00:00.000Z`)`. Unvalidated, anything
 * unparseable produced an Invalid Date, which serializes to epoch 0 and silently widened the
 * window to all time - a far heavier query than the caller asked for. The refine rejects a
 * well-shaped but unreal date (2026-02-30), which ISO parsing rejects outright.
 */
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date')
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, 'Not a calendar date');

const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const CounterLogsQuerySchema = z.object({
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
  /**
   * IANA zone that startDate/endDate name a calendar day in, and that the day buckets are cut in.
   * Defaults to UTC, which is how this route behaved before the parameter existed.
   *
   * Applies to the `{logs}` branch only. The report branches persist to DailyReport /
   * WeeklyReport, whose rows are keyed by UTC date and shared across every admin, so honouring a
   * per-request zone there would let one admin's locale overwrite another's cached report.
   */
  timezone: z
    .string()
    .optional()
    .refine(val => val === undefined || isValidTimeZone(val), { message: 'Unknown IANA time zone' })
    .transform(val => val ?? 'UTC'),
  events: z
    .string()
    .optional()
    .transform(val => (val ? val.split(',').map(v => decodeURIComponent(v)) : undefined)),
  orgs: z
    .string()
    .optional()
    .transform(val => (val ? val.split(',').map(v => decodeURIComponent(v)) : undefined)),
  excludeOrgs: z
    .string()
    .optional()
    .transform(val => (val ? val.split(',').map(v => decodeURIComponent(v)) : undefined)),
  report: z
    .string()
    .optional()
    .transform(val => val === 'true'),
  includeInsights: z
    .string()
    .optional()
    .transform(val => val === 'true'),
  weeklyReport: z
    .string()
    .optional()
    .transform(val => val === 'true'),
  counterName: z.string().max(200).optional(),
  userEmail: z.string().max(200).optional(),
  metadataFilters: z
    .string()
    .optional()
    .transform((val, ctx) => {
      try {
        return parseMetadataFilters(val);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Invalid metadataFilters' });
        return z.NEVER;
      }
    }),
  // Bounded as well as positive: an absurd page yields a $skip Mongo rejects (500) and mints a
  // fresh 1h cache document per distinct value after running the full aggregation.
  page: z.coerce.number().int().positive().max(1_000_000).prefault(1),
  // Clamped rather than rejected: an over-large page is a client bug, not a caller error,
  // and the cap is what keeps the response under Lambda's 6MB limit.
  limit: z.coerce
    .number()
    .int()
    .positive()
    .prefault(DEFAULT_PAGE_SIZE)
    .transform(val => Math.min(val, MAX_PAGE_SIZE)),
});

interface DailyReportResponse {
  date: string;
  report: string;
  aiInsights?: string | null;
}

interface WeeklyReportData {
  weekStart: string;
  weekEnd: string;
  metrics: Record<string, counterService.KpiMetrics>;
  userActivity: counterService.UserActivityMetrics;
  aiInsights?: string | null;
  peakDay?: {
    date: string;
    totalEvents: number;
  };
  peakTime?: {
    hour: number;
    avgEvents: number;
  };
  lastWeekPeakDay?: {
    date: string;
    totalEvents: number;
  };
  lastWeekPeakTime?: {
    hour: number;
    avgEvents: number;
  };
  topOrganizations?: Array<{
    name: string;
    events: number;
    rankChange?: 'up' | 'down' | 'new' | 'same';
    lastWeekRank?: number | 'new' | '>#10';
  }>;
  usageBySource?: Array<{ source: CompletionSource; count: number }>;
}

// requiredScopes: an API key reaching this route gets its CASL ability rebuilt from `user.isAdmin`
// (server/middlewares/apiKeyAuth.ts), so the `Permission.read` check below passes for any
// admin-owned key regardless of the scopes it was issued with. The scope gate is what makes a
// narrow key stay narrow; it only runs for API-key callers, so browser/JWT admins are unaffected.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get<
  Request<{}, {}, {}, Record<string, string>>
>(async (req, res) => {
  if (!req.ability?.can(Permission.read, CounterLog)) {
    throw new ForbiddenError('Unauthorized');
  }

  try {
    const {
      startDate,
      endDate,
      timezone,
      events,
      orgs,
      excludeOrgs,
      report,
      includeInsights,
      weeklyReport,
      counterName,
      userEmail,
      metadataFilters,
      page,
      limit,
    } = CounterLogsQuerySchema.parse(qs.parse(req.query));

    // For report requests, check cache first
    if (report || weeklyReport) {
      const cacheKey = `reports:${startDate}:${endDate}:${report}:${weeklyReport}:${includeInsights}`;

      const cachedResult = await cacheRepository.findByKey(cacheKey);
      if (cachedResult) {
        return sendMaybeGzip(req, res, cachedResult.result);
      }

      // Get API key for insights
      let apiKey: string | null = null;
      if (includeInsights) {
        try {
          const operationsModel = await OperationsModelService.getOperationsModel();
          apiKey = await getEffectiveApiKeyByBackend(req.user?.id || 'system', operationsModel.modelInfo.backend);
        } catch (error) {
          console.error('Failed to get operations model: %s', error);
        }
      }

      const response = weeklyReport
        ? await generateWeeklyReportResponse(startDate, endDate, apiKey, includeInsights)
        : await generateDailyReportResponse(startDate, endDate, apiKey, includeInsights);

      // Cache the result with 1 hour expiry for reports
      try {
        await cacheRepository.createOrUpdate({
          key: cacheKey,
          result: response,
          expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
        });
      } catch (error) {
        console.error('Failed to cache reports: %s', error);
      }

      return sendMaybeGzip(req, res, response);
    } else {
      // Filter-scoped, NOT page-scoped: the entry holds a window of the sorted result set, so
      // every page of one filter set shares it and costs one aggregation between them
      // (userActivityCache.ts). `limit` stays out of the key for the same reason - the window is
      // sliced to whatever page size asks for it.
      //
      // Each segment is percent-encoded before joining. counterName/userEmail are free text,
      // so a raw ':' in one segment would otherwise shift the delimiter and let two different
      // filter sets collide - e.g. counterName='a:b' + userEmail='c' vs counterName='a' +
      // userEmail='b:c' - serving one admin the other's rows and total for the full hour.
      const cacheKey = [
        // v4: day buckets are now cut in the caller's timezone, so a v3 window holds rows bucketed
        // differently for what is otherwise the same filter set.
        'logs:v4',
        ...[
          startDate,
          endDate,
          timezone,
          events?.join(',') ?? '',
          orgs?.join(',') ?? '',
          excludeOrgs?.join(',') ?? '',
          counterName ?? '',
          userEmail ?? '',
          JSON.stringify(metadataFilters ?? []),
        ].map(encodeURIComponent),
      ].join(':');

      const skip = (page - 1) * limit;

      const cachedResult = await cacheRepository.findByKey(cacheKey);
      const cachedWindow = asWindow(cachedResult?.result);
      if (cachedWindow && windowCoversPage(cachedWindow, skip, limit)) {
        return sendMaybeGzip(req, res, {
          logs: sliceWindow(cachedWindow, skip, limit),
          total: cachedWindow.total,
          page,
          limit,
        });
      }

      // A window that the byte budget already cut short cannot be grown by re-fetching it, so a
      // page beyond it is fetched alone rather than re-materializing the same truncated window.
      const windowRows = cachedWindow?.truncated ? null : windowRowsFor(skip, limit, cachedWindow?.rows.length);

      const { pipeline, facetStages } = buildUserActivityPipeline({
        startDate,
        endDate,
        timezone,
        // A cacheable window always starts at 0 so any earlier page can be sliced out of it.
        skip: windowRows === null ? skip : 0,
        limit: windowRows ?? limit,
        events,
        orgs,
        excludeOrgs,
        counterName,
        userEmail,
        metadataFilters,
        usersCollection: User.collection.name,
      });

      // No `hint`: measured with explain() on this collection's real index set, forcing
      // { datetime: 1 } makes Mongo examine 4x the documents on the filtered shape the UI
      // actually sends (orgs/excludeOrgs are always present), because it blocks the
      // { datetime, counterName, userOrganization } compound index the planner would pick.
      // A hint would also hard-fail the whole request if the index were ever absent.
      const [facet] = await executeFacetCompatible(CounterLog, convertPipelineForDocumentDB(pipeline), facetStages, {
        allowDiskUse: true,
        maxTimeMS: AGGREGATION_MAX_TIME_MS,
      });
      const fetched: unknown[] = facet?.rows ?? [];
      const total = facet?.total?.[0]?.value ?? 0;

      if (windowRows === null) {
        return sendMaybeGzip(req, res, { logs: fetched, total, page, limit });
      }

      const cacheEntry = buildWindow(fetched, total);

      // Cache the window with 1 hour expiry
      try {
        await cacheRepository.createOrUpdate({
          key: cacheKey,
          result: cacheEntry,
          expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
        });
      } catch (error) {
        console.error('Failed to cache logs: %s', error);
      }

      // Sliced from what was fetched, not from the cache entry: the byte budget only bounds what is
      // stored, and this page was materialized whether or not it survived the trim.
      return sendMaybeGzip(req, res, { logs: fetched.slice(skip, skip + limit), total, page, limit });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Keyed `issues`, not `error`: errorHandler spreads additionalInfo and then writes its own
      // `error` message over it, so a detail under that name never reaches the client.
      throw new BadRequestError('Invalid query parameters', { issues: error.issues });
    }
    throw error;
  }
});

const generateWeeklyReportResponse = async (
  startDate: string,
  endDate: string,
  apiKey: string | null,
  shouldIncludeInsights: boolean
) => {
  try {
    const cachedReport = await weeklyReportRepository.findByDateRange(startDate, endDate);
    if (cachedReport) {
      return {
        reports: [
          {
            startDate,
            endDate,
            report: cachedReport.report,
            aiInsights: cachedReport.aiInsights,
          },
        ],
      };
    }

    const today = dayjs().format('YYYY-MM-DD');
    const isHistoricalWeek = dayjs(endDate).isBefore(today, 'day');
    const reportEndDate = isHistoricalWeek
      ? dayjs(endDate).endOf('day').format('YYYY-MM-DD HH:mm:ss.SSS')
      : dayjs().format('YYYY-MM-DD HH:mm:ss.SSS');

    const logger = new Logger();

    // Get metrics for the entire week
    const weeklyData = await counterService.generateDailyReport(
      {
        date: reportEndDate,
        startDate,
        endDate,
      },
      {
        db: { counterLogs: counterLogRepository },
        logger,
      }
    );

    const hasMetrics = weeklyData?.metrics && Object.keys(weeklyData.metrics).length > 0;

    if (!hasMetrics) {
      const noActivityReport = `No activity data found for week of ${startDate} to ${endDate}`;

      if (isHistoricalWeek) {
        await weeklyReportRepository.upsertReport(startDate, endDate, noActivityReport);
      }

      return {
        reports: [
          {
            startDate,
            endDate,
            report: noActivityReport,
            aiInsights: null,
          },
        ],
      };
    }

    let aiInsights = null;
    if (shouldIncludeInsights) {
      try {
        const operationsModel = await OperationsModelService.getOperationsModel();
        aiInsights = await counterService.generateAgnosticAiInsights(
          weeklyData,
          apiKey || '',
          operationsModel.modelInfo.backend,
          operationsModel.modelInfo.id,
          true
        );
      } catch (error) {
        console.error('Failed to generate AI insights for week of %s: %s', startDate, error);
      }
    }

    const reportData: WeeklyReportData = {
      weekStart: startDate,
      weekEnd: endDate,
      metrics: weeklyData.metrics || {},
      userActivity: {
        totalUniqueUsers: weeklyData.userActivity?.totalUniqueUsers || 0,
        internalUsers: weeklyData.userActivity?.internalUsers || 0,
        externalUsers: weeklyData.userActivity?.externalUsers || 0,
        topUsers: (weeklyData.userActivity?.topUsers || []).map(user => ({
          ...user,
          interactions: Number(user.interactions) || 0,
          _id: user._id || '',
          email: user.email || 'Unknown User',
          rankChange: user.rankChange || 'same',
          lastWeekRank: user.lastWeekRank || '>#20',
        })),
        topModels: (weeklyData.userActivity?.topModels || []).map(model => ({
          ...model,
          count: Number(model.count) || 0,
          modelName: model.modelName || 'Unknown Model',
          rankChange: model.rankChange || 'same',
          lastWeekRank: model.lastWeekRank || '>#10',
        })),
      },
      aiInsights,
      peakDay: weeklyData.peakDay
        ? {
            date: weeklyData.peakDay.date,
            totalEvents: Number(weeklyData.peakDay.totalEvents) || 0,
          }
        : undefined,
      peakTime: weeklyData.peakTime
        ? {
            hour: Number(weeklyData.peakTime.hour) || 0,
            avgEvents: Number(weeklyData.peakTime.avgEvents) || 0,
          }
        : undefined,
      lastWeekPeakDay: weeklyData.lastWeekPeakDay
        ? {
            date: weeklyData.lastWeekPeakDay.date,
            totalEvents: Number(weeklyData.lastWeekPeakDay.totalEvents) || 0,
          }
        : undefined,
      lastWeekPeakTime: weeklyData.lastWeekPeakTime
        ? {
            hour: Number(weeklyData.lastWeekPeakTime.hour) || 0,
            avgEvents: Number(weeklyData.lastWeekPeakTime.avgEvents) || 0,
          }
        : undefined,
      topOrganizations: weeklyData.topOrganizations?.map(org => ({
        name: org.name || 'Unknown Organization',
        events: Number(org.events) || 0,
        rankChange: org.rankChange || 'same',
        lastWeekRank: org.lastWeekRank || '>#10',
      })),
      usageBySource: weeklyData.usageBySource,
    };

    const formattedReport = counterService.formatWeeklySlackMessage(process.env.APP_NAME || '', reportData);

    if (isHistoricalWeek) {
      try {
        await weeklyReportRepository.upsertReport(startDate, endDate, formattedReport, aiInsights);
      } catch (error) {
        console.error('Failed to cache weekly report for %s to %s: %s', startDate, endDate, error);
      }
    }

    return {
      reports: [
        {
          startDate,
          endDate,
          report: formattedReport,
          aiInsights,
        },
      ],
    };
  } catch (error) {
    console.error('Error generating weekly report: %s', error);
    return {
      reports: [
        {
          startDate,
          endDate,
          report: `Error generating report: ${error instanceof Error ? error.message : String(error)}`,
          aiInsights: null,
        },
      ],
    };
  }
};

const generateDailyReportResponse = async (
  startDate: string,
  endDate: string,
  apiKey: string | null,
  shouldIncludeInsights: boolean
) => {
  const reports: DailyReportResponse[] = [];
  const today = dayjs().format('YYYY-MM-DD');
  const logger = new Logger();

  const start = dayjs(startDate);
  const end = dayjs(endDate);
  const allDates = [];
  let current = start;
  while (current.isSameOrBefore(end)) {
    allDates.push(current.format('YYYY-MM-DD'));
    current = current.add(1, 'day');
  }

  const cachedReports = await DailyReport.find({
    date: { $in: allDates },
  });

  const cachedReportsMap = new Map(cachedReports.map(report => [report.date, report]));

  // Check which dates have data in CounterLog collection
  const datesWithData = await CounterLog.aggregate([
    {
      $match: {
        datetime: {
          $gte: new Date(`${startDate}T00:00:00.000Z`),
          $lte: new Date(`${endDate}T23:59:59.999Z`),
        },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: '$datetime',
            timezone: 'UTC',
          },
        },
      },
    },
  ]).then(results => new Set(results.map(r => r._id)));

  // Calculate metrics ONLY if we have any dates that need processing AND have data
  const datesNeedingProcessing = allDates.filter(date => {
    const isHistoricalDate = dayjs(date).isBefore(today, 'day');
    return (!isHistoricalDate || !cachedReportsMap.has(date)) && datesWithData.has(date);
  });

  if (datesNeedingProcessing.length > 0) {
    logger.log('Calculating metrics for dates:', datesNeedingProcessing);
  }

  // Process each date
  for (const date of allDates) {
    try {
      const isHistoricalDate = dayjs(date).isBefore(today, 'day');
      const cachedReport = cachedReportsMap.get(date);

      if (isHistoricalDate && cachedReport) {
        reports.push({
          date,
          report: cachedReport.report,
          aiInsights: cachedReport.aiInsights,
        });
        continue;
      }

      if (!datesWithData.has(date)) {
        const noActivityReport = `No activity data found for ${date}`;
        if (isHistoricalDate) {
          await dailyReportRepository.upsertReport(date, noActivityReport);
        }
        reports.push({
          date,
          report: noActivityReport,
        });
        continue;
      }

      const dateMetrics = await counterService.generateDailyReport(
        {
          date,
        },
        {
          db: { counterLogs: counterLogRepository },
          logger,
        }
      );

      if (!dateMetrics || (!dateMetrics.metrics && !dateMetrics.logs)) {
        const noActivityReport = `No activity data found for ${date}`;
        if (isHistoricalDate) {
          await dailyReportRepository.upsertReport(date, noActivityReport);
        }
        reports.push({
          date,
          report: noActivityReport,
        });
        continue;
      }

      let aiInsights = null;
      if (shouldIncludeInsights) {
        try {
          const operationsModel = await OperationsModelService.getOperationsModel();

          // when api key is null, its bedrock model
          aiInsights = await counterService.generateAgnosticAiInsights(
            dateMetrics,
            apiKey || '',
            operationsModel.modelInfo.backend,
            operationsModel.modelInfo.id,
            false
          );
        } catch (error) {
          console.error('Failed to generate AI insights for %s: %s', date, error);
        }
      }

      const formattedReport = counterService.formatCustomSlackMessage(process.env.APP_NAME || '', {
        ...dateMetrics,
        date,
        aiInsights,
      });

      if (isHistoricalDate) {
        await dailyReportRepository.upsertReport(date, formattedReport, aiInsights);
      }

      reports.push({
        date,
        report: formattedReport,
        aiInsights,
      });
    } catch (error) {
      console.error('Error generating report for %s: %s', date, error);
      reports.push({
        date,
        report: `Error generating report for ${date}: ${error}`,
      });
    }
  }

  // Sort reports by date (newest first)
  return { reports: reports.sort((a, b) => dayjs(b.date).diff(dayjs(a.date))) };
};

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
