import { slackAuditLogRepository, SlackAuditEventType } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

/**
 * Admin API for querying Slack audit logs
 *
 * GET: Query audit logs with filters
 */

const QuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  slackUserId: z.string().optional(),
  slackTeamId: z.string().optional(),
  eventType: z.enum(['command', 'interaction', 'event', 'api_call']).optional(),
  action: z.string().optional(),
  success: z
    .string()
    .optional()
    .transform(val => {
      if (val === 'true') return true;
      if (val === 'false') return false;
      return undefined;
    }),
  limit: z
    .string()
    .optional()
    .transform(val => {
      const parsed = val ? parseInt(val, 10) : 50;
      return Math.min(parsed, 500); // Cap at 500
    }),
});

const ensureAdmin = (isAdmin?: boolean | null) => {
  if (!isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }
};

const handler = baseApi().get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const result = QuerySchema.safeParse(req.query);
  if (!result.success) {
    throw new BadRequestError(result.error.issues[0]?.message || 'Invalid query parameters');
  }

  const { startDate, endDate, slackUserId, slackTeamId, eventType, action, success, limit } = result.data;

  // Build filters
  const filters: {
    slackTeamId?: string;
    slackUserId?: string;
    eventType?: SlackAuditEventType;
    action?: string;
    success?: boolean;
  } = {};

  if (slackTeamId) filters.slackTeamId = slackTeamId;
  if (slackUserId) filters.slackUserId = slackUserId;
  if (eventType) filters.eventType = eventType;
  if (action) filters.action = action;
  if (success !== undefined) filters.success = success;

  // Query logs using findByDateRange which supports all filters
  const start = startDate ? new Date(startDate) : new Date(0);
  const end = endDate ? new Date(endDate) : new Date();
  const logs = await slackAuditLogRepository.findByDateRange(start, end, filters, limit);

  Logger.info('📋 [Admin] Queried Slack audit logs', {
    filters,
    limit,
    count: logs.length,
    adminUserId: req.user?.id,
  });

  return res.json({
    logs,
    count: logs.length,
    limit,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
