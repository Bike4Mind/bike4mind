import { Logger } from '@bike4mind/observability';
import { isPlaceholderValue } from '@bike4mind/common';
import { McpServerName } from '@bike4mind/common';
import {
  integrationHealthCheckRepository,
  userRepository,
  mcpServerRepository,
  orgSlackWorkspaceRepository,
  slackDevWorkspaceRepository,
  INTEGRATION_HEALTH_INTEGRATIONS,
  INTEGRATION_HEALTH_THRESHOLDS,
} from '@bike4mind/database';
import type { IntegrationName, IntegrationHealthStatus, IIntegrationHealthCheckDocument } from '@bike4mind/database';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { AtlassianTokenManager } from '@server/integrations/jira/atlassianTokenManager';
import { emitMetrics } from '@server/utils/cloudwatch';
import { decryptToken } from '@server/security/tokenEncryption';

const INTEGRATION_HEALTH_NAMESPACE = 'Lumina5/IntegrationHealth';

// --- Types ---

interface ProbeResult {
  integration: IntegrationName;
  status: IntegrationHealthStatus;
  latencyMs: number;
  statusCode: number | null;
  error: string | null;
  configMissing?: boolean;
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
 * Probe Slack API using auth.test (lightest possible call - validates token).
 * Uses the bot token from a connected Slack workspace (OrgSlackWorkspace or SlackDevWorkspace).
 */
async function probeSlack(logger: Logger, _ctx: ProbeContext): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const slackBotToken = await getSlackTokenForProbe(logger);

    if (!slackBotToken) {
      return {
        integration: 'slack',
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        statusCode: null,
        error: 'No Slack workspace connected (no org or dev workspace with bot token found)',
        configMissing: true,
        metadata: {},
      };
    }

    // Use raw fetch to Slack auth.test - avoids importing the full SlackClient
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${slackBotToken}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const latencyMs = Date.now() - start;
    const data = await response.json();

    if (!response.ok || !data.ok) {
      return {
        integration: 'slack',
        status: 'unhealthy',
        latencyMs,
        statusCode: response.status,
        error: data.error || `HTTP ${response.status}`,
        metadata: {},
      };
    }

    return {
      integration: 'slack',
      status: classifyLatency(latencyMs),
      latencyMs,
      statusCode: response.status,
      error: null,
      metadata: {},
    };
  } catch (error) {
    return {
      integration: 'slack',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      statusCode: null,
      error: error instanceof Error ? error.message : String(error),
      metadata: {},
    };
  }
}

/**
 * Probe GitHub API using GET /user.
 * Uses a user-level OAuth token from the first user with GitHub MCP server connected.
 * Falls back to the system-level LIVEOPS_GITHUB_TOKEN if no user tokens are available.
 */
async function probeGitHub(logger: Logger, _ctx: ProbeContext): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const githubToken = await getGitHubTokenForProbe(logger);

    if (!githubToken) {
      return {
        integration: 'github',
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        statusCode: null,
        error: 'No GitHub connection found (no user with GitHub MCP server connected)',
        configMissing: true,
        metadata: {},
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': `${process.env.APP_NAME || 'App'}-HealthCheck`,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const latencyMs = Date.now() - start;

    const rateLimitRemaining = parseInt(response.headers.get('x-ratelimit-remaining') ?? '', 10) || undefined;
    const rateLimitLimit = parseInt(response.headers.get('x-ratelimit-limit') ?? '', 10) || undefined;
    const rateLimitReset = parseInt(response.headers.get('x-ratelimit-reset') ?? '', 10) || undefined;

    if (!response.ok) {
      return {
        integration: 'github',
        status: 'unhealthy',
        latencyMs,
        statusCode: response.status,
        error: `HTTP ${response.status}`,
        metadata: { rateLimitRemaining, rateLimitLimit, rateLimitReset },
      };
    }

    return {
      integration: 'github',
      status: classifyLatency(latencyMs),
      latencyMs,
      statusCode: response.status,
      error: null,
      metadata: { rateLimitRemaining, rateLimitLimit, rateLimitReset },
    };
  } catch (error) {
    return {
      integration: 'github',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      statusCode: null,
      error: error instanceof Error ? error.message : String(error),
      metadata: {},
    };
  }
}

/**
 * Probe Jira API using GET /myself.
 * Uses the first user with an active Atlassian connection as a proxy.
 */
async function probeJira(logger: Logger, ctx: ProbeContext): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const tokens = await getAtlassianTokensForProbe(logger, ctx);

    if (!tokens) {
      return {
        integration: 'jira',
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        statusCode: null,
        error: 'No active Atlassian connection found for health probe',
        configMissing: true,
        metadata: {},
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`https://api.atlassian.com/ex/jira/${tokens.cloudId}/rest/api/3/myself`, {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return {
        integration: 'jira',
        status: 'unhealthy',
        latencyMs,
        statusCode: response.status,
        error: `HTTP ${response.status}`,
        metadata: {},
      };
    }

    return {
      integration: 'jira',
      status: classifyLatency(latencyMs),
      latencyMs,
      statusCode: response.status,
      error: null,
      metadata: {},
    };
  } catch (error) {
    return {
      integration: 'jira',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      statusCode: null,
      error: error instanceof Error ? error.message : String(error),
      metadata: {},
    };
  }
}

/**
 * Probe Confluence API using GET /user/current.
 * Uses the same Atlassian tokens as Jira (same OAuth connection).
 */
async function probeConfluence(logger: Logger, ctx: ProbeContext): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const tokens = await getAtlassianTokensForProbe(logger, ctx);

    if (!tokens) {
      return {
        integration: 'confluence',
        status: 'unhealthy',
        latencyMs: Date.now() - start,
        statusCode: null,
        error: 'No active Atlassian connection found for health probe',
        configMissing: true,
        metadata: {},
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(
        `https://api.atlassian.com/ex/confluence/${tokens.cloudId}/wiki/rest/api/user/current?expand=personalSpace`,
        {
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return {
        integration: 'confluence',
        status: 'unhealthy',
        latencyMs,
        statusCode: response.status,
        error: `HTTP ${response.status}`,
        metadata: {},
      };
    }

    return {
      integration: 'confluence',
      status: classifyLatency(latencyMs),
      latencyMs,
      statusCode: response.status,
      error: null,
      metadata: {},
    };
  } catch (error) {
    return {
      integration: 'confluence',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      statusCode: null,
      error: error instanceof Error ? error.message : String(error),
      metadata: {},
    };
  }
}

// --- Helpers ---

/**
 * Find a Slack bot token from a connected workspace to use for probing.
 * Checks OrgSlackWorkspace first (org-level install), then SlackDevWorkspace (dev workspace).
 */
async function getSlackTokenForProbe(logger: Logger): Promise<string | null> {
  try {
    // Check org-level Slack workspaces first (production installs)
    const orgWorkspaces = await orgSlackWorkspaceRepository.find({ enabled: true });
    for (const ws of orgWorkspaces) {
      const withToken = await orgSlackWorkspaceRepository.findByOrganizationIdWithToken(ws.organizationId);
      if (withToken?.slackBotToken) {
        return decryptToken(withToken.slackBotToken);
      }
    }

    // Fallback to dev workspaces
    const devWorkspaces = await slackDevWorkspaceRepository.findAllActive();
    for (const ws of devWorkspaces) {
      const withToken = await slackDevWorkspaceRepository.findByIdWithToken(ws.id);
      if (withToken?.slackBotToken) {
        return decryptToken(withToken.slackBotToken);
      }
    }

    logger.warn('No Slack workspace with bot token found for health probe');
    return null;
  } catch (error) {
    logger.error('Error getting Slack token for health probe', { error });
    return null;
  }
}

/**
 * Find a user with an active GitHub MCP server to use for probing.
 * Uses user-level OAuth tokens only (no system-level fallback).
 */
async function getGitHubTokenForProbe(logger: Logger): Promise<string | null> {
  try {
    // Find a user with GitHub MCP server enabled
    const githubServer = await mcpServerRepository.findOne({
      name: McpServerName.Github,
      enabled: true,
    });

    if (githubServer) {
      const tokenVar = githubServer.envVariables?.find(env => env.key === 'GITHUB_ACCESS_TOKEN');
      if (tokenVar?.value && !isPlaceholderValue(tokenVar.value)) {
        return decryptToken(tokenVar.value);
      }
    }

    logger.warn('No GitHub token found (no user with GitHub MCP server connected)');
    return null;
  } catch (error) {
    logger.error('Error getting GitHub token for health probe', { error });
    return null;
  }
}

/**
 * Per-invocation cache for Atlassian tokens.
 *
 * Jira and Confluence share the same OAuth connection, so we avoid fetching
 * tokens twice when both probes run in the same invocation. The cache is
 * scoped to a `ProbeContext` object created fresh for each `runAllProbes` /
 * `runProbe` call, avoiding stale state across Lambda warm starts.
 */
interface ProbeContext {
  atlassianTokens?: { accessToken: string; cloudId: string } | null;
}

async function getAtlassianTokensForProbe(
  logger: Logger,
  ctx: ProbeContext
): Promise<{ accessToken: string; cloudId: string } | null> {
  if (ctx.atlassianTokens !== undefined) {
    return ctx.atlassianTokens;
  }

  try {
    // Find a user with active Atlassian connection
    const user = await userRepository.findOne({
      'atlassianConnect.status': 'connected',
      'atlassianConnect.accessToken': { $exists: true },
    });

    if (!user) {
      logger.warn('No user with active Atlassian connection found for health probe');
      ctx.atlassianTokens = null;
      return null;
    }

    const tokens = await AtlassianTokenManager.getValidTokens(user.id);
    if (!tokens) {
      logger.warn('Failed to get valid Atlassian tokens for health probe');
      ctx.atlassianTokens = null;
      return null;
    }

    ctx.atlassianTokens = {
      accessToken: tokens.accessToken,
      cloudId: tokens.cloudId,
    };
    return ctx.atlassianTokens;
  } catch (error) {
    logger.error('Error getting Atlassian tokens for health probe', { error });
    ctx.atlassianTokens = null;
    return null;
  }
}

function classifyLatency(latencyMs: number): IntegrationHealthStatus {
  if (latencyMs > INTEGRATION_HEALTH_THRESHOLDS.LATENCY_CRITICAL_MS) return 'unhealthy';
  if (latencyMs > INTEGRATION_HEALTH_THRESHOLDS.LATENCY_WARNING_MS) return 'degraded';
  return 'healthy';
}

// --- Public API ---

const PROBE_MAP: Record<IntegrationName, (logger: Logger, ctx: ProbeContext) => Promise<ProbeResult>> = {
  slack: probeSlack,
  github: probeGitHub,
  jira: probeJira,
  confluence: probeConfluence,
};

/**
 * Run health probes for all integrations concurrently.
 * Each probe is isolated - one failure won't block others.
 */
export async function runAllProbes(logger: Logger): Promise<IIntegrationHealthCheckDocument[]> {
  // Fresh context per invocation - Jira and Confluence share Atlassian tokens
  // within this call, but nothing leaks across Lambda warm starts.
  const ctx: ProbeContext = {};

  const results = await Promise.allSettled(
    INTEGRATION_HEALTH_INTEGRATIONS.map(async integration => {
      const probe = PROBE_MAP[integration];
      const result = await probe(logger, ctx);
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

  // Publish CloudWatch metrics (fire-and-forget - don't block on metric failures)
  publishMetrics(recorded, logger).catch(err => {
    logger.error('Failed to publish CloudWatch metrics', { error: err });
  });

  return recorded;
}

/**
 * Run a health probe for a single integration.
 */
export async function runProbe(integration: IntegrationName, logger: Logger): Promise<IIntegrationHealthCheckDocument> {
  const ctx: ProbeContext = {};
  const probe = PROBE_MAP[integration];
  const result = await probe(logger, ctx);
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
 */
async function publishMetrics(checks: IIntegrationHealthCheckDocument[], logger: Logger): Promise<void> {
  const metrics = checks.flatMap(check => [
    {
      name: 'Latency',
      value: check.latencyMs,
      dimensions: { Integration: check.integration },
      unit: StandardUnit.Milliseconds,
    },
    {
      name: 'Success',
      value: check.status === 'healthy' ? 1 : 0,
      dimensions: { Integration: check.integration },
      unit: StandardUnit.Count,
    },
    {
      name: 'Failure',
      value: check.status === 'unhealthy' ? 1 : 0,
      dimensions: { Integration: check.integration },
      unit: StandardUnit.Count,
    },
  ]);

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
