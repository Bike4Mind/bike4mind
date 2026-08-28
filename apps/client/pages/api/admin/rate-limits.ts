import { Request } from 'express';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { RateLimitSnapshot } from '@bike4mind/database';

const handler = baseApi().get(async (req: Request, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const { dateFrom, dateTo, integration, throttledOnly, limit } = req.query;

  // Build query filter
  const query: Record<string, unknown> = {};

  if (dateFrom || dateTo) {
    const timestampFilter: Record<string, Date> = {};
    // An unparseable value becomes an Invalid Date and throws a Mongoose CastError on the
    // `timestamp` filter, which reaches errorHandler as a 500. Reject it here instead.
    for (const [name, value] of [
      ['dateFrom', dateFrom],
      ['dateTo', dateTo],
    ] as const) {
      if (value && Number.isNaN(Date.parse(value as string))) {
        throw new BadRequestError(`Invalid ${name}: must be a parseable date`);
      }
    }
    if (dateFrom) timestampFilter.$gte = new Date(dateFrom as string);
    if (dateTo) timestampFilter.$lte = new Date(dateTo as string);
    query.timestamp = timestampFilter;
  }

  if (integration) {
    query.integration = integration;
  }

  if (throttledOnly === 'true') {
    query.wasThrottled = true;
  }

  const maxResults = Math.min(Number(limit) || 500, 1000);

  const snapshots = await RateLimitSnapshot.find(query).sort({ timestamp: -1 }).limit(maxResults).lean();

  return res.json(snapshots);
});

export default handler;
