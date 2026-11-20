/**
 * SecOps Triage Worker
 *
 * SQS consumer Lambda that processes security scan findings fanned out from
 * ingest endpoints (web-owasp, secrets, packages, code-semgrep).
 * Creates/updates/auto-closes GitHub issues via the b4m-prod GitHub App
 * for critical and high severity findings.
 *
 * Triggered by: SQS secopsTriageQueue
 */

import { SQSEvent, Context } from 'aws-lambda';
import { z } from 'zod';
import { Logger } from '@bike4mind/observability';
import {
  AdminSettings,
  secopsTriageRunRepository,
  slackDevWorkspaceRepository,
  type RecordSecopsTriageRunInput,
} from '@bike4mind/database';
import { SecopsTriageConfigSchema, SECOPS_TRIAGE_SCAN_SOURCES } from '@bike4mind/common';
import { SlackClient } from '@bike4mind/slack';
import { GitHubService } from '@bike4mind/server-utils/services/githubService';
import {
  checkSecopsTriageRepo,
  type SecopsTriageRepoIssue,
} from '@bike4mind/server-utils/security/secopsTriageRepoCheck';
import { createSecopsTriageService } from '@workers/services/secopsTriageService';
import { decryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import { Resource } from 'sst';

const CLOUDWATCH_NAMESPACE = 'Lumina5/SecOpsTriage';
const SETTING_NAME = 'secopsTriageConfig';

const REPO_ISSUE_TEXT: Record<SecopsTriageRepoIssue, string> = {
  not_configured: 'no repository is set',
  not_allowed: "the repository is not in the GitHub connection's allowed repositories",
  not_found: 'the repository was not found',
  public: 'the repository is public',
  archived: 'the repository is archived',
  issues_disabled: 'issues are disabled on the repository',
};

type RunOutcome = Omit<RecordSecopsTriageRunInput, 'stage' | 'scanSource' | 'findingCount' | 'startedAt'>;

const SecopsTriagePayloadSchema = z.object({
  stage: z.string(),
  targetUrl: z.string().optional(),
  scanSource: z.enum(SECOPS_TRIAGE_SCAN_SOURCES).default('web-owasp'),
  snapshotId: z.string().optional(),
  findings: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      description: z.string().optional(),
      recommendation: z.string().optional(),
      documentationUrl: z.string().optional(),
      instances: z
        .array(
          z.object({
            uri: z.string(),
            param: z.string().optional(),
            evidence: z.string().optional(),
            otherinfo: z.string().optional(),
          })
        )
        .default([]),
    })
  ),
  findingsComplete: z.boolean().default(true),
  unverifiedFindingIds: z.array(z.string()).default([]),
});

async function getSlackBotToken(logger: Logger, workspaceId?: string): Promise<string | null> {
  try {
    if (workspaceId) {
      const workspace = await slackDevWorkspaceRepository.findByIdWithToken(workspaceId);
      if (workspace) {
        logger.info('[SECOPS-WORKER] Using configured Slack workspace', { workspaceId });
        return decryptToken(workspace.slackBotToken) ?? null;
      }
      logger.warn('[SECOPS-WORKER] Configured workspace not found, falling back to first active', { workspaceId });
    }

    // Fallback: use first active workspace
    const activeWorkspaces = await slackDevWorkspaceRepository.findAllActive();
    if (activeWorkspaces.length > 0 && activeWorkspaces[0].slackTeamId) {
      const workspace = await slackDevWorkspaceRepository.findBySlackTeamIdWithToken(activeWorkspaces[0].slackTeamId);
      const token = decryptToken(workspace?.slackBotToken) ?? null;
      if (token) {
        logger.warn('[SECOPS-WORKER] No workspace configured, using first active workspace', {
          workspaceId: activeWorkspaces[0].id,
          workspaceName: activeWorkspaces[0].name,
        });
      }
      return token;
    }
  } catch (err) {
    logger.warn('[SECOPS-WORKER] Could not fetch Slack bot token (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

export const handler = dispatchWithLogger(async (event: SQSEvent, _context: Context, logger: Logger) => {
  const stage = Resource.App.stage;

  const record = event.Records[0];
  if (!record) {
    logger.error('[SECOPS-WORKER] No message in SQS event');
    return;
  }

  let payload: z.infer<typeof SecopsTriagePayloadSchema>;
  try {
    payload = SecopsTriagePayloadSchema.parse(JSON.parse(record.body));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('[SECOPS-WORKER] Invalid SQS message', { error: msg, body: record.body.slice(0, 500) });
    // Malformed messages will never succeed - don't retry
    return;
  }

  const runStartedAt = new Date();
  // Never fatal: a run record is for the admin status view and must not change the outcome.
  const recordRun = async (outcome: RunOutcome) => {
    try {
      await secopsTriageRunRepository.record({
        stage,
        scanSource: payload.scanSource,
        findingCount: payload.findings.length,
        startedAt: runStartedAt,
        ...outcome,
      });
    } catch (error) {
      logger.warn('[SECOPS-WORKER] Could not record the triage run (non-fatal)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const setting = await AdminSettings.findOne({ settingName: SETTING_NAME });
  const parseResult = SecopsTriageConfigSchema.safeParse(setting?.settingValue ?? {});
  if (!parseResult.success) {
    logger.warn('[SECOPS-WORKER] SecOps Triage config is invalid - skipping', {
      issues: parseResult.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
    });
    await recordRun({ status: 'skipped', reason: 'invalid_config', dryRun: false });
    return;
  }
  const config = parseResult.data;

  if (!config.enabled) {
    logger.info('[SECOPS-WORKER] SecOps Triage disabled in config — skipping');
    await recordRun({ status: 'skipped', reason: 'disabled', dryRun: config.dryRun });
    return;
  }

  logger.info('[SECOPS-WORKER] Starting SecOps Triage', {
    stage,
    findingCount: payload.findings.length,
    dryRun: config.dryRun,
    threshold: config.severityThreshold,
    maxIssues: config.maxIssuesPerScan,
    llmEnrichment: config.llmEnrichment,
    modelId: config.modelId ?? null,
  });

  // forSystem() returns null only for permanent config states (no connection / disabled /
  // suspended) - swallow those so the message isn't retried into the DLQ needlessly.
  // Transient failures (DB error, auth init) throw and are retried by SQS automatically.
  const githubService = await GitHubService.forSystem(logger);
  if (!githubService) {
    logger.warn(
      '[SECOPS-WORKER] No system GitHub connection configured — skipping (permanent failure, will not retry)'
    );
    await emitMetric(
      CLOUDWATCH_NAMESPACE,
      'TriageRunFailure',
      1,
      { Stage: stage, ErrorType: 'NoGitHubConnection' },
      StandardUnit.Count
    );
    await recordRun({ status: 'skipped', reason: 'no_github_connection', dryRun: config.dryRun });
    return;
  }

  // Get Slack bot token for summary posting (non-fatal if unavailable)
  const slackBotToken = config.slackChannelId ? await getSlackBotToken(logger, config.slackWorkspaceId) : null;
  if (config.slackChannelId && !slackBotToken) {
    logger.warn(
      '[SECOPS-WORKER] slackChannelId configured but no active Slack workspace found — skipping Slack summary'
    );
  }

  const service = createSecopsTriageService(logger);
  const startTime = Date.now();

  try {
    // A repository that cannot take issues is a permanent configuration state, like a missing
    // connection: skip without retrying. A failed lookup throws and is retried below.
    const repoCheck = await checkSecopsTriageRepo(githubService, config.githubRepo);
    if (!repoCheck.ok) {
      logger.error('[SECOPS-WORKER] SecOps Triage repository cannot take issues - skipping (will not retry)', {
        repo: config.githubRepo,
        reason: repoCheck.reason,
      });
      await emitMetric(
        CLOUDWATCH_NAMESPACE,
        'TriageRunFailure',
        1,
        { Stage: stage, ErrorType: 'RepoNotWritable' },
        StandardUnit.Count
      );
      if (config.slackChannelId && slackBotToken) {
        try {
          await new SlackClient(slackBotToken, logger).sendMessage({
            channel: config.slackChannelId,
            text: `SecOps triage skipped ${payload.scanSource} scan results on ${stage}: ${REPO_ISSUE_TEXT[repoCheck.reason]}. No GitHub issues were filed or updated.`,
          });
        } catch (slackError) {
          logger.warn('[SECOPS-WORKER] Could not post the repository warning to Slack (non-fatal)', {
            error: slackError instanceof Error ? slackError.message : String(slackError),
          });
        }
      }
      await recordRun({ status: 'skipped', reason: repoCheck.reason, dryRun: config.dryRun });
      return;
    }

    const result = await service.run(payload, githubService, config, slackBotToken ?? undefined);
    const duration = Date.now() - startTime;

    // Emit CloudWatch metrics (skip for dry runs)
    if (!config.dryRun) {
      await Promise.all([
        emitMetric(CLOUDWATCH_NAMESPACE, 'IssuesCreated', result.issuesCreated, { Stage: stage }, StandardUnit.Count),
        emitMetric(CLOUDWATCH_NAMESPACE, 'IssuesUpdated', result.issuesUpdated, { Stage: stage }, StandardUnit.Count),
        emitMetric(CLOUDWATCH_NAMESPACE, 'IssuesReopened', result.issuesReopened, { Stage: stage }, StandardUnit.Count),
        emitMetric(CLOUDWATCH_NAMESPACE, 'IssuesClosed', result.issuesClosed, { Stage: stage }, StandardUnit.Count),
        emitMetric(
          CLOUDWATCH_NAMESPACE,
          'IssuesSuppressed',
          result.issuesSuppressed,
          { Stage: stage },
          StandardUnit.Count
        ),
        emitMetric(
          CLOUDWATCH_NAMESPACE,
          'IssuesDeduplicated',
          result.issuesDeduplicated,
          { Stage: stage },
          StandardUnit.Count
        ),
        emitMetric(CLOUDWATCH_NAMESPACE, 'TriageDuration', duration, { Stage: stage }, StandardUnit.Milliseconds),
        emitMetric(CLOUDWATCH_NAMESPACE, 'TriageRunSuccess', 1, { Stage: stage }, StandardUnit.Count),
      ]);
    }

    logger.info('[SECOPS-WORKER] SecOps Triage completed', {
      stage,
      durationMs: duration,
      ...result,
    });
    await recordRun({
      status: 'completed',
      dryRun: config.dryRun,
      durationMs: duration,
      counts: {
        created: result.issuesCreated,
        updated: result.issuesUpdated,
        reopened: result.issuesReopened,
        closed: result.issuesClosed,
        suppressed: result.issuesSuppressed,
        belowThreshold: result.skippedBelowThreshold,
        overCap: result.skippedRateLimit,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('[SECOPS-WORKER] SecOps Triage failed', { error: errorMessage });

    await emitMetric(
      CLOUDWATCH_NAMESPACE,
      'TriageRunFailure',
      1,
      { Stage: stage, ErrorType: 'RuntimeError' },
      StandardUnit.Count
    );
    await recordRun({
      status: 'failed',
      dryRun: config.dryRun,
      durationMs: Date.now() - startTime,
      error: errorMessage,
    });

    // Re-throw to trigger DLQ after retries exhausted
    throw error;
  }
});
