import { integrationAuditLogRepository } from '@bike4mind/database';
import type {
  IntegrationAuditEntityType,
  IntegrationAuditIntegrationName,
  IntegrationAuditOutcome,
} from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

const QuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  entityType: z.enum(['oauth', 'webhook', 'mcp_tool', 'token_refresh']).optional(),
  integrationName: z.enum(['github', 'atlassian', 'slack', 'linear', 'notion']).optional(),
  outcome: z.enum(['success', 'failure', 'rate_limited']).optional(),
  userId: z.string().optional(),
  workspaceId: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform(val => {
      if (!val) return 50;
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? 50 : Math.min(Math.max(parsed, 1), 500);
    }),
});

const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const result = QuerySchema.safeParse(req.query);
  if (!result.success) {
    throw new BadRequestError(result.error.issues[0]?.message || 'Invalid query parameters');
  }

  const { startDate, endDate, entityType, integrationName, outcome, userId, workspaceId, limit } = result.data;

  const filters: {
    entityType?: IntegrationAuditEntityType;
    integrationName?: IntegrationAuditIntegrationName;
    outcome?: IntegrationAuditOutcome;
    userId?: string;
    workspaceId?: string;
  } = {};

  if (entityType) filters.entityType = entityType;
  if (integrationName) filters.integrationName = integrationName;
  if (outcome) filters.outcome = outcome;
  if (userId) filters.userId = userId;
  if (workspaceId) filters.workspaceId = workspaceId;

  const start = startDate ? new Date(startDate) : new Date(0);
  const end = endDate ? new Date(endDate) : new Date();

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new BadRequestError('Invalid date format for startDate or endDate');
  }

  const logs = await integrationAuditLogRepository.findByDateRange(start, end, filters, limit);

  Logger.info('[Admin] Queried integration audit logs', {
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
