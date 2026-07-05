/**
 * SRE Revision logic
 *
 * Receives an SreRevisionRequest (delivered via sreJobQueue with
 * jobType: 'revision' and routed here by the sreJob handler) when a reviewer
 * requests changes on an sre-fix/* PR. Re-runs the Diagnostician with the original
 * diagnosis + reviewer feedback, then dispatches to sreFixQueue for the revised fix.
 *
 * Runs on the shared sreJobQueue consumer (8-minute Lambda timeout) for LLM calls.
 */

import { getSettingsByNames } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';
import { sendToQueue } from '@server/utils/sqs';
import {
  adminSettingsRepository,
  apiKeyRepository,
  cacheRepository,
  sreErrorTrackingRepository,
} from '@bike4mind/database';
import {
  SreAgentConfigSchema,
  SRE_DEFAULT_REPO_SLUG,
  resolveFullConfig,
  type SreFixRequest,
  type SreEventPayload,
  type SreRevisionRequest,
  SreClassification,
} from '@bike4mind/common';
import { SreAgentService } from '@bike4mind/services/sreAgentService';
import { RATE_LIMITED_SENTINEL } from '@bike4mind/services/sreAgentService/tools';
import { GitHubService, GitHubRateLimitError } from '@server/services/githubService';
import { apiKeyService } from '@bike4mind/services';
import {
  postSreRevisionStartedMessage,
  postSreFixFailureMessage,
  postSreAnalysisFailureMessage,
  postSreRateLimitedMessage,
  postSreNoFixNeededMessage,
} from '@server/integrations/slack/sreSlackApproval';
import { buildWontFixCommentBody, WONT_FIX_COMMENT_MARKER } from '@server/integrations/sre/wontFixComment';

/** HTML marker so the self-heal escalation comment is posted at most once per PR/issue. */
const SRE_SELFHEAL_ESCALATION_MARKER = '<!-- sre-selfheal-escalation -->';

/**
 * Post a clean escalation comment when a CI self-heal cannot proceed without a human -
 * either the only viable fix would edit a test (Rule 2 block) or the bot exhausted/failed
 * its attempts. Comments on the PR when one exists, else the source issue. Best-effort:
 * Slack remains the primary signal, so failures here are logged and swallowed.
 * TOCTOU note: two concurrent escalations could both pass hasCommentWithMarker before either
 * posts - blast radius is a duplicate cosmetic comment, no state divergence.
 */
async function postSelfHealEscalationComment(
  githubService: GitHubService,
  repoSlug: string,
  prNumber: number,
  issueNumber: number | undefined,
  reason: string,
  ciFailureOutput: string | undefined,
  logger: Logger
): Promise<void> {
  const target = prNumber > 0 ? prNumber : issueNumber;
  if (!target) return; // No PR or issue to comment on (e.g. CloudWatch-only) — Slack covers it.
  try {
    const alreadyPosted = await githubService.hasCommentWithMarker(repoSlug, target, SRE_SELFHEAL_ESCALATION_MARKER);
    if (alreadyPosted) return;
    const body = [
      SRE_SELFHEAL_ESCALATION_MARKER,
      '**SRE Agent — Self-Heal Escalation**',
      '',
      reason,
      ...(ciFailureOutput
        ? [
            '',
            '<details><summary>Failing test output</summary>',
            '',
            '```',
            ciFailureOutput.slice(0, 2000),
            '```',
            '</details>',
          ]
        : []),
      '',
      'A human is needed to supersede this fix. The bot will not edit a test to make a failing test pass — if the test encodes intended behavior the fix contradicts, update the source (or the test, deliberately) by hand.',
    ].join('\n');
    await githubService.addIssueComment(repoSlug, target, body);
  } catch (err) {
    logger.error('Failed to post self-heal escalation comment (non-fatal)', { error: err });
  }
}

/** Clear the repo-scoped revision dedup key so a new review can trigger another revision attempt. */
async function clearRevisionDedup(repoSlug: string, prNumber: number) {
  // prNumber=0 is a sentinel for CI-retry fresh-branch flows - no dedup key to clear
  if (prNumber === 0) return;
  try {
    await cacheRepository.deleteByKey(`sre-revision-${repoSlug}-${prNumber}`);
  } catch {
    // Non-fatal - dedup key will expire naturally after 1 hour
  }
}

/**
 * Core revision logic, decoupled from the Lambda entrypoint so it can be driven
 * by the merged sreJobQueue handler (sreJob.dispatch) for jobType: 'revision'.
 * Receives an already-validated request.
 */
export async function runSreRevision(revisionRequest: SreRevisionRequest, logger: Logger): Promise<void> {
  logger.updateMetadata({ handler: 'sreRevision' });

  const repoSlug = revisionRequest.repoSlug ?? SRE_DEFAULT_REPO_SLUG;
  logger.updateMetadata({
    trackingId: revisionRequest.trackingId,
    fingerprint: revisionRequest.fingerprint,
    prNumber: revisionRequest.prNumber,
    repoSlug,
  });
  logger.info('Processing revision request');

  // Load config
  const rawConfig = await adminSettingsRepository.getSettingsValue('sreAgentConfig');
  const config = SreAgentConfigSchema.parse(rawConfig ?? {});
  const repoConfig = resolveFullConfig(config, repoSlug);

  if (!repoConfig) {
    logger.warn('Repo not configured, skipping revision', { repoSlug });
    await sreErrorTrackingRepository.atomicTransition(revisionRequest.trackingId, 'revision_requested', 'failed', {
      errorMessage: 'Repo not configured',
    });
    // Intentionally no Slack notification here: repoConfig is null, so slackConfig is unavailable.
    // Operators can detect this via CloudWatch logs (logger.warn above) or the failed doc in the admin UI.
    await clearRevisionDedup(repoSlug, revisionRequest.prNumber);
    return;
  }

  if (!repoConfig.enabled) {
    logger.info('SRE agent disabled, skipping revision');
    await sreErrorTrackingRepository.atomicTransition(revisionRequest.trackingId, 'revision_requested', 'failed', {
      errorMessage: 'SRE agent disabled during revision',
    });
    try {
      await postSreAnalysisFailureMessage(
        revisionRequest.trackingId,
        revisionRequest.fingerprint,
        '',
        'SRE agent disabled during revision',
        repoSlug,
        repoConfig.slack ?? {},
        'Revision'
      );
    } catch (slackErr) {
      logger.error('Failed to send agent-disabled Slack notification (non-fatal)', { error: slackErr });
    }
    await clearRevisionDedup(repoSlug, revisionRequest.prNumber);
    return;
  }

  // Circuit breaker check (per-repo)
  const cooldown = repoConfig.circuitBreaker.cooldownMinutes;
  const repoFailures = await sreErrorTrackingRepository.countConsecutiveFailures(repoSlug, cooldown);
  if (repoFailures >= repoConfig.circuitBreaker.failureThreshold) {
    const revCbFailureReason = `Circuit breaker open (repo: ${repoFailures} consecutive failures)`;
    logger.warn('Circuit breaker OPEN, skipping revision', {
      repoFailures,
      threshold: repoConfig.circuitBreaker.failureThreshold,
    });
    await sreErrorTrackingRepository.atomicTransition(revisionRequest.trackingId, 'revision_requested', 'failed', {
      errorMessage: revCbFailureReason,
    });
    try {
      await postSreAnalysisFailureMessage(
        revisionRequest.trackingId,
        revisionRequest.fingerprint,
        '',
        revCbFailureReason,
        repoSlug,
        repoConfig.slack ?? {},
        'Revision'
      );
    } catch (slackErr) {
      logger.error('Failed to send circuit-breaker Slack notification (non-fatal)', { error: slackErr });
    }
    await clearRevisionDedup(repoSlug, revisionRequest.prNumber);
    return;
  }

  // Daily rate limit: revisions count toward the same daily fix cap (per-repo)
  const repoFixesToday = await sreErrorTrackingRepository.countFixesDispatchedToday(repoSlug);
  if (repoFixesToday >= repoConfig.maxFixesPerDay) {
    logger.warn('Daily fix rate limit reached, skipping revision', {
      repoFixesToday,
      repoMaxFixesPerDay: repoConfig.maxFixesPerDay,
    });
    await sreErrorTrackingRepository.atomicTransition(
      revisionRequest.trackingId,
      'revision_requested',
      'rate_limited',
      {
        errorMessage: `Daily fix rate limit reached (${repoFixesToday}/${repoConfig.maxFixesPerDay})`,
      }
    );
    try {
      await postSreRateLimitedMessage(
        revisionRequest.trackingId,
        revisionRequest.originalDiagnosis,
        '',
        revisionRequest.fingerprint,
        { fixesToday: repoFixesToday, maxFixesPerDay: repoConfig.maxFixesPerDay },
        `https://github.com/${repoSlug}/pull/${revisionRequest.prNumber}`,
        repoConfig.slack ?? {}
      );
    } catch (slackErr) {
      logger.error('Failed to send rate-limited Slack notification (non-fatal)', { error: slackErr });
    }
    await clearRevisionDedup(repoSlug, revisionRequest.prNumber);
    return;
  }

  // Get API keys for LLM
  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(
    'system',
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
    { logger }
  );

  // Get GitHub service for tool context
  // forSystem() throws for transient failures (DB error, auth init) - catch and rethrow
  // so SQS retries the message with the tracking record intact. No state update here:
  // marking as failed before rethrow would corrupt the state for the retry.
  // clearRevisionDedup is called before rethrowing so the dedup key doesn't block
  // the SQS retry (key would otherwise prevent the retry for up to 1 hour).
  let githubService: GitHubService | null;
  try {
    githubService = await GitHubService.forSystem(logger);
  } catch (error) {
    logger.error('GitHub service init failed (transient) — SQS will retry', {
      trackingId: revisionRequest.trackingId,
      error: error instanceof Error ? error.message : String(error),
    });
    await clearRevisionDedup(repoSlug, revisionRequest.prNumber);
    throw error;
  }
  if (!githubService) {
    logger.error('GitHub service unavailable');
    await sreErrorTrackingRepository.atomicTransition(revisionRequest.trackingId, 'revision_requested', 'failed', {
      errorMessage: 'GitHub service unavailable during revision',
    });
    try {
      await postSreAnalysisFailureMessage(
        revisionRequest.trackingId,
        revisionRequest.fingerprint,
        '',
        'GitHub service unavailable during revision',
        `https://github.com/${repoSlug}/pull/${revisionRequest.prNumber}`,
        repoConfig.slack ?? {},
        'Revision'
      );
    } catch (slackErr) {
      logger.error('Failed to send GitHub-unavailable Slack notification (non-fatal)', { error: slackErr });
    }
    await clearRevisionDedup(repoSlug, revisionRequest.prNumber);
    return;
  }

  // Read files from the PR branch (not main) so the diagnostician sees the
  // current state of the code including prior fix attempts. This ensures the
  // generated `before` strings match what's actually on the branch.
  const branchRef = revisionRequest.branchName;

  const toolContext = {
    getFileContent: (path: string) => githubService.getFileContent(repoSlug, path, branchRef),
    searchCode: async (query: string) => {
      // Note: GitHub code search API only indexes the default branch.
      // Search results may reference main's code, but subsequent getFileContent
      // calls will read the correct branch version.
      try {
        const results = await githubService.searchCode(repoSlug, query);
        if (results.length === 0) return 'No results found. Try github_file_read with a specific path.';
        return JSON.stringify(results.slice(0, 5).map(r => ({ path: r.path, matches: r.textMatches })));
      } catch (err) {
        if (err instanceof GitHubRateLimitError) {
          return `${RATE_LIMITED_SENTINEL} (10 req/min). Use github_file_read to read specific files instead, or github_list_files to browse directories.`;
        }
        throw err;
      }
    },
    listFiles: async (path: string) => {
      const entries = await githubService.listDirectoryContents(repoSlug, path, branchRef);
      return entries.map(e => e.path);
    },
    apiCallCounter: { count: 0, max: repoConfig.tokenBudget.maxGithubApiCalls },
  };

  // Post Slack notification that revision has started.
  // Skip when prNumber=0 (CI-retry fresh-branch flow - no PR URL yet).
  if (revisionRequest.prNumber > 0) {
    try {
      await postSreRevisionStartedMessage(
        revisionRequest.trackingId,
        revisionRequest.fingerprint,
        `https://github.com/${repoSlug}/pull/${revisionRequest.prNumber}`,
        (await sreErrorTrackingRepository.findByPrNumber(revisionRequest.prNumber, repoSlug))?.revisionCount ?? 1,
        repoConfig.slack ?? {}
      );
    } catch (slackErr) {
      logger.error('Failed to post revision started message (non-fatal)', { error: slackErr });
    }
  }

  // Build a minimal SreEventPayload for the Diagnostician
  const payload: SreEventPayload = {
    source: revisionRequest.source,
    fingerprint: revisionRequest.fingerprint,
    repoSlug,
    classification: SreClassification.HIGH,
    errorMessage: revisionRequest.originalDiagnosis.rootCause,
    issueNumber: revisionRequest.issueNumber,
  };

  // Run the Diagnostician in revision mode
  const service = new SreAgentService(logger);
  const result = await service.revise(
    payload,
    repoConfig,
    apiKeyTable,
    toolContext,
    revisionRequest.originalDiagnosis,
    revisionRequest.reviewBody ?? 'Reviewer requested changes (no specific feedback provided)',
    revisionRequest.ciFailureOutput
  );

  if (!result.diagnosis) {
    const reason = result.noChange
      ? 'Revision produced identical fix — no progress made'
      : (result.failureReason ?? 'Diagnostician revision failed');

    logger.warn('Revision diagnosis failed', { reason });
    await sreErrorTrackingRepository.atomicTransition(revisionRequest.trackingId, 'revision_requested', 'failed', {
      errorMessage: reason,
    });

    try {
      await postSreFixFailureMessage(
        revisionRequest.trackingId,
        revisionRequest.fingerprint,
        '',
        `Revision failed — ${reason}`,
        '',
        repoConfig.slack ?? {}
      );
    } catch (slackErr) {
      logger.error('Failed to post revision failure message (non-fatal)', { error: slackErr });
    }
    // CI self-heal that can't proceed (e.g. the only fix would edit a test - Rule 2 - or attempts
    // exhausted) escalates cleanly with a PR/issue comment carrying the failing output, so a human
    // supersedes instead of finding a bare red run. Presence check (!= null), not truthiness: an
    // empty-string output is still a CI self-heal (the field is absent only for human-review revisions).
    if (revisionRequest.ciFailureOutput != null) {
      await postSelfHealEscalationComment(
        githubService,
        repoSlug,
        revisionRequest.prNumber,
        revisionRequest.issueNumber,
        `Automated self-heal could not fix the failing tests without editing a test, or exhausted its attempts (${reason}).`,
        revisionRequest.ciFailureOutput,
        logger
      );
    }
    await clearRevisionDedup(repoSlug, revisionRequest.prNumber);
    return;
  }

  // Explicit escalation: the Diagnostician judged that a human must decide (e.g. the failing test
  // encodes intended behavior the fix contradicts). Land in `failed` with an escalation comment
  // rather than dispatching a no-op fix or framing it as "no fix needed".
  if (result.diagnosis.escalate) {
    logger.info('[SRE-REVISION] Diagnostician escalated to human', {
      fingerprint: revisionRequest.fingerprint,
      rootCause: result.diagnosis.rootCause?.slice(0, 200),
    });
    await sreErrorTrackingRepository.atomicTransition(revisionRequest.trackingId, 'revision_requested', 'failed', {
      diagnosisResult: result.diagnosis,
      errorMessage: 'Escalated to human — fix would require editing a test or conflicts with test intent',
    });
    try {
      await postSreFixFailureMessage(
        revisionRequest.trackingId,
        revisionRequest.fingerprint,
        '',
        'Revision escalated to human — fix conflicts with test intent',
        '',
        repoConfig.slack ?? {}
      );
    } catch (slackErr) {
      logger.error('Failed to post revision escalation Slack message (non-fatal)', { error: slackErr });
    }
    await postSelfHealEscalationComment(
      githubService,
      repoSlug,
      revisionRequest.prNumber,
      revisionRequest.issueNumber,
      `Automated self-heal escalated: ${result.diagnosis.rootCause}`,
      revisionRequest.ciFailureOutput,
      logger
    );
    await clearRevisionDedup(repoSlug, revisionRequest.prNumber);
    return;
  }

  // Short-circuit: no effective file changes means no code fix needed.
  // Mirrors sreAnalysis.ts step 6.5b for the revision path so CI-retry re-diagnoses
  // returning `affectedFiles: []` (e.g., "fix already applied") don't get dispatched
  // to GitHub Actions only to time out and land in `failed`.
  const effectiveFiles = result.diagnosis.affectedFiles.filter(f => f.before !== f.after);
  if (effectiveFiles.length === 0) {
    logger.info('[SRE-REVISION] No effective file changes — no fix needed', {
      fingerprint: revisionRequest.fingerprint,
      confidence: result.diagnosis.confidence,
      rootCause: result.diagnosis.rootCause?.slice(0, 200),
    });
    const wontFixTransitioned = await sreErrorTrackingRepository.atomicTransition(
      revisionRequest.trackingId,
      'revision_requested',
      'wont_fix',
      {
        diagnosisResult: result.diagnosis,
        errorMessage: 'Revision determined no code fix is needed',
      }
    );
    if (!wontFixTransitioned) {
      logger.warn('Failed to transition to wont_fix — status may have changed', {
        trackingId: revisionRequest.trackingId,
      });
      await clearRevisionDedup(repoSlug, revisionRequest.prNumber);
      return;
    }
    const sourceRef =
      revisionRequest.prNumber > 0
        ? `https://github.com/${repoSlug}/pull/${revisionRequest.prNumber}`
        : revisionRequest.issueNumber
          ? `https://github.com/${repoSlug}/issues/${revisionRequest.issueNumber}`
          : 'unknown';
    try {
      await postSreNoFixNeededMessage(
        revisionRequest.trackingId,
        result.diagnosis,
        revisionRequest.originalDiagnosis.rootCause,
        revisionRequest.fingerprint,
        sourceRef,
        repoConfig.slack ?? {}
      );
    } catch (slackErr) {
      logger.error('Failed to send no-fix-needed Slack notification (non-fatal)', { error: slackErr });
    }
    // GH issue comment - tells the issue author the revision concluded no code fix is needed.
    // Deduped via HTML marker. Skipped when there's no source issue (e.g., CloudWatch-only flows).
    if (revisionRequest.issueNumber) {
      try {
        const alreadyPosted = await githubService.hasCommentWithMarker(
          repoSlug,
          revisionRequest.issueNumber,
          WONT_FIX_COMMENT_MARKER
        );
        if (!alreadyPosted) {
          await githubService.addIssueComment(
            repoSlug,
            revisionRequest.issueNumber,
            buildWontFixCommentBody(result.diagnosis, 'revision')
          );
        }
      } catch (ghErr) {
        logger.error('Failed to post wont-fix GH comment (non-fatal)', { error: ghErr });
      }
    }
    await clearRevisionDedup(repoSlug, revisionRequest.prNumber);
    return;
  }

  // Transition to fixing and dispatch to sreFixQueue
  const transitioned = await sreErrorTrackingRepository.atomicTransition(
    revisionRequest.trackingId,
    'revision_requested',
    'fixing',
    {
      diagnosisResult: result.diagnosis,
      dispatchedAt: new Date(),
    }
  );

  if (!transitioned) {
    logger.warn('Failed to transition to fixing — status may have changed', {
      trackingId: revisionRequest.trackingId,
    });
    return;
  }

  // Build fix request. CI retries (prNumber=0) create a fresh branch/PR rather than
  // revising an existing one (the original CI failure occurred before PR creation).
  const fixRequest: SreFixRequest = {
    trackingId: revisionRequest.trackingId,
    fingerprint: revisionRequest.fingerprint,
    repoSlug,
    diagnosis: result.diagnosis,
    source: revisionRequest.source,
    issueNumber: revisionRequest.issueNumber,
    // Rule 2 - a CI self-heal (driven by recoverable CI failure output) must never edit a test.
    // Propagate to the applier so it rejects any test-file patch as defense-in-depth.
    // Presence check (!= null), not truthiness: an empty-string output is still a CI self-heal.
    blockTestEdits: revisionRequest.ciFailureOutput != null,
    ...(revisionRequest.prNumber > 0
      ? {
          revision: {
            branchName: revisionRequest.branchName,
            prNumber: revisionRequest.prNumber,
            revisionCount: transitioned.revisionCount ?? 1,
          },
        }
      : {}),
  };

  await sendToQueue(Resource.sreFixQueue.url, fixRequest as unknown as Record<string, unknown>);

  logger.info('Revision fix request dispatched', {
    trackingId: revisionRequest.trackingId,
    branchName: revisionRequest.branchName,
    revisionCount: transitioned.revisionCount,
    confidence: result.diagnosis.confidence,
  });
}
