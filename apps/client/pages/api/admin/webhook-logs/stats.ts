import { webhookAuditLogRepository } from '@bike4mind/database';
import { IWebhookAuditFilters, WebhookAuditStatus, WebhookSourceType } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

/**
 * Admin API for webhook audit log statistics
 *
 * GET: Get aggregated statistics for webhook deliveries
 */

// Maximum allowed date range (90 days) to prevent DoS via expensive aggregation queries
const MAX_DATE_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

// Cache duration for stats (5 minutes)
const CACHE_MAX_AGE_SECONDS = 300;

const QuerySchema = z.object({
  startDate: z
    .string()
    .optional()
    .refine(val => !val || !isNaN(Date.parse(val)), {
      error: 'Invalid startDate format',
    }),
  endDate: z
    .string()
    .optional()
    .refine(val => !val || !isNaN(Date.parse(val)), {
      error: 'Invalid endDate format',
    }),
  repository: z.string().optional(),
  event: z.string().optional(),
  status: z.enum(WebhookAuditStatus).optional(),
  organizationId: z.string().optional(),
  mcpServerId: z.string().optional(),
  sourceType: z.enum(['org', 'user']).optional(),
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

  const { startDate, endDate, repository, event, status, organizationId, mcpServerId, sourceType } = result.data;

  // Default date range: last 7 days if not specified
  const start = startDate ? new Date(startDate) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const end = endDate ? new Date(endDate) : new Date();

  // Validate date range doesn't exceed 90 days (DoS prevention for expensive aggregations)
  if (end.getTime() - start.getTime() > MAX_DATE_RANGE_MS) {
    throw new BadRequestError('Date range must not exceed 90 days');
  }

  // Build filters - status is already validated by Zod enum
  const filters: IWebhookAuditFilters = {};

  if (repository) filters.repository = repository;
  if (event) filters.event = event;
  if (status) filters.status = status;
  if (organizationId) filters.organizationId = organizationId;
  if (mcpServerId) filters.mcpServerId = mcpServerId;
  if (sourceType) filters.sourceType = sourceType as WebhookSourceType;

  // Get summary statistics
  const summary = await webhookAuditLogRepository.getAuditSummary(start, end, filters);

  Logger.info('[Admin] Retrieved webhook audit stats', {
    filters,
    dateRange: { start, end },
    totalDeliveries: summary.totalDeliveries,
    successRate: summary.successRate,
    adminUserId: req.user?.id,
  });

  // Set cache headers to reduce load from repeated requests
  res.setHeader('Cache-Control', `private, max-age=${CACHE_MAX_AGE_SECONDS}`);

  return res.json(summary);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
