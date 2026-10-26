import { Logger } from '@bike4mind/observability';
import {
  integrationHealthCheckRepository,
  INTEGRATION_HEALTH_INTEGRATIONS,
  INTEGRATION_HEALTH_THRESHOLDS,
} from '@bike4mind/database';
import type { IntegrationName, IntegrationHealthStatus, IIntegrationHealthCheckDocument } from '@bike4mind/database';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { emitMetrics } from '../utils/cloudwatch';

const INTEGRATION_HEALTH_NAMESPACE = 'Lumina5/IntegrationHealth';

// --- Types ---

interface ProbeResult {
  integration: IntegrationName;
  status: IntegrationHealthStatus;
  latencyMs: number;
  statusCode: number | null;
  error: string | null;
  metadata: {
    rateLimitRemaining?: number;
    rateLimitLimit?: number;
    rateLimitReset?: number;
  };
}

interface HealthSummary {
  integration: IntegrationName;
  status: IntegrationHealthStatus;
  latencyMs: number;
  lastCheckedAt: Date;
  successRate: number;
  consecutiveFailures: number;
  error: string | null;
}

/** Timeout for probe fetch calls - prevents Lambda execution time exhaustion */
const PROBE_TIMEOUT_MS = 10_000;

// --- Probe Functions ---

/**
 * Probes check that each provider's API answers at all, without any credential.
 *
 * Their results drive the platform-wide availability circuit (integrationCircuitBreaker), so they
 * must not borrow a tenant's token: a token that is revoked, expired or rate-limited is that
 * tenant's problem, and treating it as an outage would block the integration for every tenant.
 * Per-tenant failures are tracked by the per-tenant breakers in mcpCircuitBreakers instead, which
 * probe results never feed. Any HTTP response below 500 - including 401/403/404/429 for the
 * missing credential - proves the provider is reachable. The one exception is Slack's `ok` body,
 * which is only checked on a 2xx.
 */
type ProbeTarget = {
  url: string;
  method: 'GET' | 'POST';
  /** Slack reports its own failures as HTTP 200 with `ok: false`; api.test answers `ok: true` unauthenticated. */
  requiresOkBody?: boolean;
};

const PROBE_TARGETS: Record<IntegrationName, ProbeTarget> = {
  slack: { url: 'https://slack.com/api/api.test', method: 'POST', requiresOkBody: true },
  github: { url: 'https://api.github.com/', method: 'GET' },
  // The Atlassian gateway answers 404 itself, so these detect gateway reachability, not Jira/Confluence
  // backend health: a product outage behind the gateway still reads healthy.
  jira: { url: 'https://api.atlassian.com/ex/jira', method: 'GET' },
  confluence: { url: 'https://api.atlassian.com/ex/confluence', method: 'GET' },
};

const SERVER_ERROR_STATUS = 500;

async function probeReachability(integration: IntegrationName): Promise<ProbeResult> {
  const { url, method, requiresOkBody } = PROBE_TARGETS[integration];
  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers: { 'User-Agent': `${process.env.APP_NAME || 'App'}-HealthCheck` },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;

    if (response.status >= SERVER_ERROR_STATUS) {
      return {
        integration,
        status: 'unhealthy',
        latencyMs,
        statusCode: response.status,
        error: `HTTP ${response.status}`,
        metadata: {},
      };
    }

    if (requiresOkBody && response.ok) {
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!body.ok) {
        return {
          integration,
          status: 'unhealthy',
          latencyMs,
          statusCode: response.status,
          error: body.error || 'ok: false',
          metadata: {},
        };
      }
    }

    return {
      integration,
      status: classifyLatency(latencyMs),
      latencyMs,
      statusCode: response.status,
      error: null,
      metadata: {},
    };
  } catch (error) {
    return {
      integration,
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      statusCode: null,
      error: error instanceof Error ? error.message : String(error),
      metadata: {},
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function classifyLatency(latencyMs: number): IntegrationHealthStatus {
  if (latencyMs > INTEGRATION_HEALTH_THRESHOLDS.LATENCY_CRITICAL_MS) return 'unhealthy';
  if (latencyMs > INTEGRATION_HEALTH_THRESHOLDS.LATENCY_WARNING_MS) return 'degraded';
  return 'healthy';
}

// --- Public API ---

/**
 * Run health probes for all integrations concurrently.
 * Each probe is isolated - one failure won't block others.
 * `emitMetrics: false` skips the CloudWatch publish for callers with no AWS (the self-host worker).
 */
export async function runAllProbes(
  logger: Logger,
  options: { emitMetrics?: boolean } = {}
): Promise<IIntegrationHealthCheckDocument[]> {
  const results = await Promise.allSettled(
    INTEGRATION_HEALTH_INTEGRATIONS.map(async integration => {
      const result = await probeReachability(integration);
      return integrationHealthCheckRepository.recordCheck(result);
    })
  );

  const recorded: IIntegrationHealthCheckDocument[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      recorded.push(result.value);
    } else {
      logger.error('Failed to record health check', { error: result.reason });
    }
  }

  // Awaited: the Lambda freezes once its handler returns, so an un-awaited PutMetricData is either
  // lost or sent on a later thaw, past its signature window ("Signature expired").
  // emitMetrics logs and swallows its own failures, so this never fails the run.
  if (options.emitMetrics !== false) {
    await publishMetrics(recorded);
  }

  return recorded;
}

/**
 * Run a health probe for a single integration.
 */
export async function runProbe(integration: IntegrationName): Promise<IIntegrationHealthCheckDocument> {
  const result = await probeReachability(integration);
  return integrationHealthCheckRepository.recordCheck(result);
}

/**
 * Get a health summary for all integrations (used by the admin dashboard).
 */
export async function getHealthSummary(logger: Logger): Promise<HealthSummary[]> {
  const summaries: HealthSummary[] = [];

  for (const integration of INTEGRATION_HEALTH_INTEGRATIONS) {
    const [latest] = await integrationHealthCheckRepository.getRecentByIntegration(integration, 1);
    const { rate } = await integrationHealthCheckRepository.getSuccessRate(integration);
    const recentChecks = await integrationHealthCheckRepository.getLastNChecks(
      integration,
      INTEGRATION_HEALTH_THRESHOLDS.FAILURE_ALERT_THRESHOLD
    );

    const consecutiveFailures = countConsecutiveFailures(recentChecks);

    summaries.push({
      integration,
      status: latest?.status ?? 'unhealthy',
      latencyMs: latest?.latencyMs ?? 0,
      lastCheckedAt: latest?.checkedAt ?? new Date(0),
      successRate: rate,
      consecutiveFailures,
      error: latest?.error ?? null,
    });
  }

  return summaries;
}

/**
 * Publish CloudWatch custom metrics for each probe result.
 * Latency is published as Milliseconds so CloudWatch can compute P50/P95/P99 natively.
 * Latency and Success are also published without a dimension: CloudWatch does not aggregate
 * across dimensions, and the high-latency and all-down alarms in infra/alarms.ts read that series.
 */
async function publishMetrics(checks: IIntegrationHealthCheckDocument[]): Promise<void> {
  const metrics = checks.flatMap(check => {
    const dimensions = { Integration: check.integration };
    const latency = { name: 'Latency', value: check.latencyMs, unit: StandardUnit.Milliseconds };
    const success = { name: 'Success', value: check.status === 'healthy' ? 1 : 0, unit: StandardUnit.Count };
    const failure = { name: 'Failure', value: check.status === 'unhealthy' ? 1 : 0, unit: StandardUnit.Count };
    return [{ ...latency, dimensions }, { ...success, dimensions }, { ...failure, dimensions }, latency, success];
  });

  await emitMetrics(INTEGRATION_HEALTH_NAMESPACE, metrics);
}

function countConsecutiveFailures(checks: IIntegrationHealthCheckDocument[]): number {
  let count = 0;
  for (const check of checks) {
    if (check.status === 'unhealthy') {
      count++;
    } else {
      break;
    }
  }
  return count;
}
