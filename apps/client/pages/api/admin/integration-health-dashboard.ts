import { Request, Response } from 'express';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import {
  integrationHealthCheckRepository,
  integrationAuditLogRepository,
  INTEGRATION_HEALTH_INTEGRATIONS,
  RateLimitSnapshot,
} from '@bike4mind/database';
import type { IntegrationName } from '@bike4mind/database';
import { getHealthSummary, runAllProbes, runProbe } from '@server/services/integrationHealthService';
import { getStatus } from '@server/services/integrationCircuitBreaker';
import { getAllBreakerStates } from '@server/services/mcpCircuitBreakers';
import { rateLimit } from '@server/middlewares/rateLimit';

const timeRangeSchema = z.enum(['24h', '7d', '30d']).default('24h');
const probeBodySchema = z.object({
  integration: z.enum(INTEGRATION_HEALTH_INTEGRATIONS).optional(),
});

const TIME_RANGE_HOURS: Record<string, number> = {
  '24h': 24,
  '7d': 168,
  '30d': 720,
};

/** Maps audit log integration names (e.g. 'atlassian') to health check names (e.g. 'jira', 'confluence') */
const AUDIT_TO_HEALTH: Record<string, IntegrationName[]> = {
  github: ['github'],
  slack: ['slack'],
  atlassian: ['jira', 'confluence'],
};

function buildHealthToAuditMap(): Record<IntegrationName, string[]> {
  const result: Record<string, string[]> = {};
  for (const [auditName, healthNames] of Object.entries(AUDIT_TO_HEALTH)) {
    for (const healthName of healthNames) {
      if (!result[healthName]) result[healthName] = [];
      result[healthName].push(auditName);
    }
  }
  return result as Record<IntegrationName, string[]>;
}

const HEALTH_TO_AUDIT = buildHealthToAuditMap();

const handler = baseApi()
  .get(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const parseResult = timeRangeSchema.safeParse(req.query.timeRange);
    if (!parseResult.success) {
      throw new BadRequestError(`Invalid timeRange: must be one of 24h, 7d, 30d`);
    }
    const timeRange = parseResult.data;
    const hours = TIME_RANGE_HOURS[timeRange];
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const inMemoryBreakerStates = getAllBreakerStates();
    const healthSummaries = await getHealthSummary(new Logger());

    const integrations = await Promise.all(
      healthSummaries.map(async summary => {
        try {
          const [circuitBreaker, rateLimitSnaps, auditErrors] = await Promise.all([
            getStatus(summary.integration),
            RateLimitSnapshot.find({
              integration: summary.integration,
              timestamp: { $gte: since },
            })
              .sort({ timestamp: -1 })
              .limit(1)
              .lean(),
            (async () => {
              const auditNames = HEALTH_TO_AUDIT[summary.integration] || [];
              if (auditNames.length === 0) return [];
              const allErrors = await Promise.all(
                auditNames.map(name =>
                  integrationAuditLogRepository.findByDateRange(
                    since,
                    new Date(),
                    {
                      integrationName: name as 'github' | 'atlassian' | 'slack',
                      outcome: 'failure',
                    },
                    10
                  )
                )
              );
              return allErrors
                .flat()
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .slice(0, 10);
            })(),
          ]);

          const latestSnap = rateLimitSnaps[0] || null;

          // Fetch recent unhealthy health checks and merge with audit log errors
          const healthCheckErrors = await integrationHealthCheckRepository
            .getRecentByIntegration(summary.integration, 10)
            .then(checks => checks.filter(c => c.status === 'unhealthy'));

          const recentErrors = [
            ...healthCheckErrors.map(c => ({
              source: 'health_check' as const,
              occurredAt: c.checkedAt.toISOString(),
              message: c.error || 'Health check failed',
              errorCode: c.statusCode ? String(c.statusCode) : null,
              entityType: null,
              action: 'health_probe',
            })),
            ...auditErrors.map(e => ({
              source: 'audit_log' as const,
              occurredAt: new Date(e.createdAt).toISOString(),
              message: `${e.action} failed${e.errorCode ? ` (${e.errorCode})` : ''}`,
              errorCode: e.errorCode || null,
              entityType: e.entityType,
              action: e.action,
            })),
          ]
            .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
            .slice(0, 10);

          return {
            name: summary.integration,
            status: summary.status,
            latencyMs: summary.latencyMs,
            lastCheckedAt: summary.lastCheckedAt.toISOString(),
            successRate: summary.successRate,
            consecutiveFailures: summary.consecutiveFailures,
            error: summary.error,
            circuitBreaker,
            rateLimit: latestSnap
              ? {
                  limit: latestSnap.limit,
                  remaining: latestSnap.remaining,
                  usagePercent: latestSnap.usagePercent,
                  resetAt: latestSnap.resetAt ? new Date(latestSnap.resetAt).toISOString() : null,
                  wasThrottled: latestSnap.wasThrottled,
                }
              : null,
            recentErrors,
          };
        } catch (err) {
          const logger = new Logger();
          logger.error(`Failed to fetch details for ${summary.integration}`, err);
          return {
            name: summary.integration,
            status: summary.status,
            latencyMs: summary.latencyMs,
            lastCheckedAt: summary.lastCheckedAt.toISOString(),
            successRate: summary.successRate,
            consecutiveFailures: summary.consecutiveFailures,
            error: summary.error || 'Failed to load integration details',
            circuitBreaker: {
              available: false,
              reason: 'Data fetch failed',
              mode: 'auto',
              autoTripped: false,
            },
            rateLimit: null,
            recentErrors: [],
          };
        }
      })
    );

    res.setHeader('Cache-Control', 'private, max-age=25');
    return res.json({
      generatedAt: new Date().toISOString(),
      timeRangeHours: hours,
      integrations,
      inMemoryBreakerStates,
    });
  })
  // Rate limit between GET and POST - baseApi applies middleware in declaration order
  .use(
    rateLimit({
      limit: 5,
      windowMs: 60 * 1000,
    })
  )
  .post(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const parseResult = probeBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError(`Invalid request body: ${parseResult.error.issues[0]?.message}`);
    }
    const { integration } = parseResult.data;
    const logger = new Logger();

    if (integration) {
      const result = await runProbe(integration as IntegrationName, logger);
      return res.json({
        integration: result.integration,
        status: result.status,
        latencyMs: result.latencyMs,
        statusCode: result.statusCode,
        error: result.error,
        checkedAt: result.checkedAt,
      });
    }

    const results = await runAllProbes(logger);
    return res.json({
      results: results.map(r => ({
        integration: r.integration,
        status: r.status,
        latencyMs: r.latencyMs,
        statusCode: r.statusCode,
        error: r.error,
        checkedAt: r.checkedAt,
      })),
    });
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
