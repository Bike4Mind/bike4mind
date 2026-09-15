import { Request, Response } from 'express';
import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { rateLimit } from '@server/middlewares/rateLimit';
import {
  integrationHealthCheckRepository,
  integrationCircuitOverrideRepository,
  INTEGRATION_HEALTH_INTEGRATIONS,
} from '@bike4mind/database';
import type { IntegrationName, CircuitBreakerMode } from '@bike4mind/database';
import { getHealthSummary, runAllProbes, runProbe } from '@server/services/integrationHealthService';
import { getStatus, clearCache } from '@server/services/integrationCircuitBreaker';
import { getAllBreakerStates, resetBreaker } from '@server/services/mcpCircuitBreakers';

const ensureAdmin = (isAdmin?: boolean | null) => {
  if (!isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }
};

const handler = baseApi()
  .get(async (req: Request, res: Response) => {
    ensureAdmin(req.user?.isAdmin);

    const { integration, history } = req.query;
    const logger = new Logger();

    // If a specific integration is requested with history=true, return time series
    if (integration && history === 'true') {
      if (!INTEGRATION_HEALTH_INTEGRATIONS.includes(integration as IntegrationName)) {
        throw new BadRequestError(`Invalid integration: ${integration}`);
      }

      const checks = await integrationHealthCheckRepository.getRecentByIntegration(integration as IntegrationName);

      return res.json({
        integration,
        checks: checks.map(c => ({
          status: c.status,
          latencyMs: c.latencyMs,
          statusCode: c.statusCode,
          error: c.error,
          checkedAt: c.checkedAt,
          metadata: c.metadata,
        })),
      });
    }

    // Default: return summary for all integrations with circuit breaker status
    const summary = await getHealthSummary(logger);

    const integrations = await Promise.all(
      summary.map(async s => {
        const circuitBreaker = await getStatus(s.integration);
        return { ...s, circuitBreaker };
      })
    );

    // Include real-time in-memory circuit breaker states
    const circuitBreakers = getAllBreakerStates();

    res.setHeader('Cache-Control', 'private, max-age=30');
    return res.json({ integrations, circuitBreakers });
  })
  .use(
    rateLimit({
      limit: 5,
      windowMs: 60 * 1000, // 5 manual probes per minute
    })
  )
  .post(async (req: Request, res: Response) => {
    ensureAdmin(req.user?.isAdmin);

    const { integration } = req.body;
    const logger = new Logger();

    // Single integration probe
    if (integration) {
      if (!INTEGRATION_HEALTH_INTEGRATIONS.includes(integration as IntegrationName)) {
        throw new BadRequestError(`Invalid integration: ${integration}`);
      }

      const result = await runProbe(integration as IntegrationName, logger);

      return res.json({
        status: result.status,
        integration: result.integration,
        latencyMs: result.latencyMs,
        statusCode: result.statusCode,
        error: result.error,
        checkedAt: result.checkedAt,
      });
    }

    // Probe all integrations
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
  })
  .put(async (req: Request, res: Response) => {
    ensureAdmin(req.user?.isAdmin);

    const { integration, mode, reason } = req.body;

    if (!integration || !INTEGRATION_HEALTH_INTEGRATIONS.includes(integration as IntegrationName)) {
      throw new BadRequestError(`Invalid integration: ${integration}`);
    }

    const validModes: CircuitBreakerMode[] = ['auto', 'force_block', 'force_open'];
    if (!mode || !validModes.includes(mode as CircuitBreakerMode)) {
      throw new BadRequestError(`Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}`);
    }

    const override = await integrationCircuitOverrideRepository.setOverride({
      integration: integration as IntegrationName,
      mode: mode as CircuitBreakerMode,
      setBy: req.user!.id,
      reason: reason || undefined,
    });

    // Clear the DB-backed circuit breaker cache so the override takes effect immediately
    clearCache(integration as IntegrationName);

    // When resetting to auto, also clear the in-memory circuit breaker state
    if (mode === 'auto') {
      resetBreaker(integration as string);
    }

    return res.json({
      integration: override.integration,
      mode: override.mode,
      setBy: override.setBy,
      setAt: override.setAt,
      reason: override.reason,
    });
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
