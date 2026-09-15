import { webhookAuditLogRepository } from '@bike4mind/database';
import { IWebhookAuditFilters, WebhookAuditStatus, WebhookSourceType } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

/**
 * Admin API for querying webhook audit logs
 *
 * GET: Query audit logs with filters and pagination
 */

// Maximum allowed date range (90 days) to prevent DoS via expensive queries
const MAX_DATE_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

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
  limit: z
    .string()
    .optional()
    .transform(val => {
      const parsed = val ? parseInt(val, 10) : 50;
      return Math.min(Math.max(parsed, 1), 100); // Clamp between 1 and 100
    }),
  cursor: z.string().optional(),
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

  const { startDate, endDate, repository, event, status, organizationId, mcpServerId, sourceType, limit, cursor } =
    result.data;

  // Default date range: last 7 days if not specified
  const start = startDate ? new Date(startDate) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const end = endDate ? new Date(endDate) : new Date();

  // Validate date range doesn't exceed 90 days (DoS prevention)
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

  // Query logs with pagination
  const paginatedResult = await webhookAuditLogRepository.findByDateRange(start, end, filters, { limit, cursor });

  Logger.info('[Admin] Queried webhook audit logs', {
    filters,
    limit,
    count: paginatedResult.logs.length,
    total: paginatedResult.total,
    hasMore: paginatedResult.hasMore,
    adminUserId: req.user?.id,
  });

  return res.json(paginatedResult);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
