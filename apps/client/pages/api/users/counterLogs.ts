import { ApiKeyScope, Permission } from '@bike4mind/common';
import {
  CounterLog,
  cacheRepository,
  convertPipelineForDocumentDB,
  executeFacetCompatible,
  User,
} from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { z } from 'zod';
import { Request } from 'express';
import qs from 'qs';
import { BadRequestError, ForbiddenError } from '@bike4mind/server-utils/utils/errors';
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
  excludeNoOrg: z
    .string()
    .optional()
    .transform(val => val === 'true'),
  excludeStaff: z
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

const ONE_MINUTE_MS = 60 * 1000;
// Higher than the 20/min on the admin help-analytics dashboard because admin actions burst
// against this one route rather than making a single request. Measured against the real callers,
// all of which go through fetchCounterLogs: the CSV export walks MAX_EXPORT_ROWS/EXPORT_PAGE_SIZE
// = 10 pages back to back (app/components/admin/EventMetrics/UserActivity/exportUserActivity.ts) and
// the grid is one request per distinct filter behind a 5-minute staleTime. A session doing all of
// that in one minute lands well under 40, so 60 leaves headroom; no caller refetches on a timer.
export const COUNTER_LOGS_RATE_LIMIT = 60;

// requiredScopes: an API key reaching this route gets its CASL ability rebuilt from `user.isAdmin`
// (server/middlewares/apiKeyAuth.ts), so the `Permission.read` check below passes for any
// admin-owned key regardless of the scopes it was issued with. The scope gate is what makes a
// narrow key stay narrow; it only runs for API-key callers, so browser/JWT admins are unaffected.
// `rateLimit` is what bounds them instead, chained after baseApi's auth so it keys on `req.user.id`
// rather than the client IP.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: COUNTER_LOGS_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'users-counter-logs' }))
  .get<Request<{}, {}, {}, Record<string, string>>>(async (req, res) => {
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
        excludeNoOrg,
        excludeStaff,
        counterName,
        userEmail,
        metadataFilters,
        page,
        limit,
      } = CounterLogsQuerySchema.parse(qs.parse(req.query));

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
          String(excludeNoOrg),
          String(excludeStaff),
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
        excludeNoOrg,
        excludeStaff,
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
    } catch (error) {
      if (error instanceof z.ZodError) {
        // Keyed `issues`, not `error`: errorHandler spreads additionalInfo and then writes its own
        // `error` message over it, so a detail under that name never reaches the client.
        throw new BadRequestError('Invalid query parameters', { issues: error.issues });
      }
      throw error;
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
