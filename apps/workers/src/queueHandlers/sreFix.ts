import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { z } from 'zod';
import { adminSettingsRepository, sreErrorTrackingRepository } from '@bike4mind/database';
import {
  SreSourceType,
  SreAgentConfigSchema,
  SRE_ANALYSIS_COMPLETED_EVENT,
  SRE_DEFAULT_REPO_SLUG,
  SRE_TEST_FILE_GLOBS,
  resolveFullConfig,
} from '@bike4mind/common';
import { GitHubService } from '@server/services/githubService';
import { postSreFixFailureMessage } from '@server/integrations/slack/sreSlackApproval';

const SreFixRequestSchema = z.object({
  trackingId: z.string(),
  fingerprint: z.string(),
  repoSlug: z.string().default(SRE_DEFAULT_REPO_SLUG),
  diagnosis: z.object({
    rootCause: z.string(),
    proposedFix: z.string(),
    confidence: z.number(),
    riskAssessment: z.string(),
    affectedFiles: z
      .array(
        z.object({
          filePath: z.string(),
          before: z.string(),
          after: z.string(),
          kind: z.enum(['insert', 'replace', 'create']).default('replace'),
        })
      )
      .min(1)
      .max(15),
    toolCalls: z
      .array(
        z.object({
          tool: z.string(),
          input: z.record(z.string(), z.unknown()),
          output: z.string(),
        })
      )
      .optional(),
  }),
  source: z.nativeEnum(SreSourceType),
  issueNumber: z.number().optional(),
  dryRun: z.boolean().optional(),
  blockTestEdits: z.boolean().optional(),
  revision: z
    .object({
      branchName: z.string(),
      prNumber: z.number(),
      revisionCount: z.number(),
    })
    .optional(),
});

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const raw = JSON.parse(event.Records[0].body);
  // The Diagnostician path arrives via an EventBridge rule (infra/eventBus.ts),
  // which wraps the payload in the full event envelope; direct SQS producers
  // (Slack approval, revision handler) send the bare fix request.
  const body =
    raw && typeof raw === 'object' && raw['detail-type'] === SRE_ANALYSIS_COMPLETED_EVENT && 'detail' in raw
      ? raw.detail
      : raw;
  const fixRequest = SreFixRequestSchema.parse(body);

  const repoSlug = fixRequest.repoSlug ?? SRE_DEFAULT_REPO_SLUG;
  logger.updateMetadata({
    handler: 'sreFix',
    trackingId: fixRequest.trackingId,
    fingerprint: fixRequest.fingerprint,
    repoSlug,
  });
  logger.info('Processing fix request');

  // Load config
  const rawConfig = await adminSettingsRepository.getSettingsValue('sreAgentConfig');
  const config = SreAgentConfigSchema.parse(rawConfig ?? {});
  const repoConfig = resolveFullConfig(config, repoSlug);

  if (!repoConfig) {
    logger.warn('Repo not configured, skipping', { repoSlug });
    return;
  }

  if (!repoConfig.enabled) {
    logger.info('SRE agent disabled, skipping');
    return;
  }

  // Circuit breaker check (per-repo)
  const cooldown = repoConfig.circuitBreaker.cooldownMinutes;
  const repoFailures = await sreErrorTrackingRepository.countConsecutiveFailures(repoSlug, cooldown);
  if (repoFailures >= repoConfig.circuitBreaker.failureThreshold) {
    logger.warn('Circuit breaker OPEN, skipping dispatch', {
      repoFailures,
      threshold: repoConfig.circuitBreaker.failureThreshold,
    });
    await sreErrorTrackingRepository.updateStatus(fixRequest.trackingId, 'failed', {
      errorMessage: `Circuit breaker open (repo: ${repoFailures})`,
    });
    return;
  }

  // Determine dry-run mode from both payload flag and fresh config
  const isDryRun = fixRequest.dryRun || repoConfig.dryRun;

  if (isDryRun) {
    logger.info('DRY-RUN: Would dispatch repository_dispatch', {
      repo: repoSlug,
      trackingId: fixRequest.trackingId,
      fingerprint: fixRequest.fingerprint,
      affectedFiles: fixRequest.diagnosis.affectedFiles.map(f => f.filePath),
      rootCause: fixRequest.diagnosis.rootCause,
      proposedFix: fixRequest.diagnosis.proposedFix,
      confidence: fixRequest.diagnosis.confidence,
    });
    await sreErrorTrackingRepository.updateStatus(fixRequest.trackingId, 'dry_run', {
      dryRun: true,
      errorMessage: `Dry run — would dispatch repository_dispatch to ${repoSlug}`,
    });
    return;
  }

  // Get GitHub service.
  // forSystem() throws for transient failures (DB error, auth init) - catch and rethrow
  // so SQS retries the message with the tracking record intact. No state update here:
  // marking as dispatch_failed before rethrow would corrupt the state for the retry.
  let githubService: GitHubService | null;
  try {
    githubService = await GitHubService.forSystem(logger);
  } catch (error) {
    logger.error('GitHub service init failed (transient) — SQS will retry', {
      trackingId: fixRequest.trackingId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  if (!githubService) {
    logger.error('GitHub service unavailable');
    await sreErrorTrackingRepository.updateStatus(fixRequest.trackingId, 'dispatch_failed', {
      errorMessage: 'GitHub service unavailable',
    });
    try {
      await postSreFixFailureMessage(
        fixRequest.trackingId,
        fixRequest.fingerprint,
        '',
        'GitHub dispatch failed — service unavailable',
        '',
        repoConfig.slack ?? {}
      );
    } catch (slackError) {
      logger.error('Failed to send Slack dispatch failure notification (non-fatal)', { error: slackError });
    }
    return;
  }

  // Idempotency guard: claim dispatch before calling GitHub.
  // If SQS retries after a crash post-dispatch, flag is already set -> skip.
  const claimed = await sreErrorTrackingRepository.claimDispatch(fixRequest.trackingId);
  if (!claimed) {
    logger.info('Dispatch already claimed or status changed, skipping', {
      trackingId: fixRequest.trackingId,
    });
    return;
  }

  // Dispatch repository_dispatch event
  const shortTimestamp = Date.now().toString(36);
  const shortFingerprint = fixRequest.fingerprint.substring(0, 8);

  // Determine dispatch type and branch name based on whether this is a revision
  const isRevision = !!fixRequest.revision;
  const dispatchType = isRevision ? 'sre-autofix-revision' : 'sre-autofix';
  const branchName = isRevision ? fixRequest.revision!.branchName : `sre-fix/${shortFingerprint}-${shortTimestamp}`;

  try {
    // Resolve reviewers from per-repo config, then legacy config
    const reviewerStr = repoConfig.reviewers;
    const reviewers = reviewerStr
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean);

    // Rule 2 - CI self-heal is source-only. For revisions driven by a recoverable CI
    // failure, append the test-file globs to the applier's blocklist so any patch touching
    // a test is rejected (defense-in-depth alongside the Diagnostician's own block). Tests
    // are NOT blocked for the initial fix - Rule 1 allows a paired source+test assertion update.
    const effectiveBlockedPatterns = [
      ...repoConfig.blockedFilePatterns,
      ...(fixRequest.blockTestEdits ? SRE_TEST_FILE_GLOBS : []),
    ];

    // GitHub repository_dispatch allows max 10 top-level properties in client_payload.
    // Current count: 10. Repo-specific and revision data is packed into the meta field.
    await githubService.createDispatchEvent(repoSlug, dispatchType, {
      fingerprint: fixRequest.fingerprint,
      trackingId: fixRequest.trackingId,
      branchName,
      affectedFiles: fixRequest.diagnosis.affectedFiles,
      rootCause: fixRequest.diagnosis.rootCause,
      proposedFix: fixRequest.diagnosis.proposedFix,
      confidence: fixRequest.diagnosis.confidence,
      riskAssessment: fixRequest.diagnosis.riskAssessment,
      meta: JSON.stringify({
        reviewers,
        repoSlug,
        issueNumber: fixRequest.issueNumber ?? null,
        baseBranch: repoConfig.defaultBranch || 'main',
        buildCommand: repoConfig.buildCommand || '',
        ...(repoConfig.allowedFilePatterns.length && {
          allowedFilePatterns: repoConfig.allowedFilePatterns,
        }),
        ...(effectiveBlockedPatterns.length && {
          blockedFilePatterns: effectiveBlockedPatterns,
        }),
        ...(isRevision && {
          revisionCount: fixRequest.revision!.revisionCount,
          prNumber: fixRequest.revision!.prNumber,
        }),
      }),
      callbackUrl: process.env.APP_URL || '',
    });

    logger.info(`Dispatched ${dispatchType}`, {
      trackingId: fixRequest.trackingId,
      branchName,
      isRevision,
      revisionCount: fixRequest.revision?.revisionCount,
    });
  } catch (error) {
    logger.error('Failed to dispatch workflow', { error });
    await sreErrorTrackingRepository.updateStatus(fixRequest.trackingId, 'dispatch_failed', {
      errorMessage: error instanceof Error ? error.message : 'Unknown dispatch error',
    });
    try {
      await postSreFixFailureMessage(
        fixRequest.trackingId,
        fixRequest.fingerprint,
        '',
        `GitHub dispatch failed — ${error instanceof Error ? error.message : 'Unknown error'}`,
        '',
        repoConfig.slack ?? {}
      );
    } catch (slackError) {
      logger.error('Failed to send Slack dispatch failure notification (non-fatal)', { error: slackError });
    }
    // Do not re-throw: dispatch_failed status is recorded. SQS retry would
    // find status !== 'fixing' in claimDispatch and skip (CAS guard).
  }
});
