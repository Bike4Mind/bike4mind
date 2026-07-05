/**
 * SRE Analysis logic (Diagnostician)
 *
 * Receives a normalized SreEventPayload (delivered via sreJobQueue with
 * jobType: 'analysis' and routed here by the sreJob handler). Performs dedup,
 * circuit breaker check, LLM root cause analysis, gate logic, and dispatches to
 * sreFixQueue if approved.
 */

import type { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';
import { getSettingsByNames } from '@bike4mind/utils';
import { sendToQueue } from '@server/utils/sqs';
import {
  adminSettingsRepository,
  apiKeyRepository,
  inboxRepository,
  sreErrorTrackingRepository,
  sreErrorPatternRepository,
} from '@bike4mind/database';
import {
  InboxType,
  SreEventPayload,
  SreSourceType,
  SreAgentConfigSchema,
  SreFixRequest,
  SRE_DEFAULT_REPO_SLUG,
  resolveFullConfig,
} from '@bike4mind/common';
import { SreAgentService, type SrePatternLookup } from '@bike4mind/services/sreAgentService';
import { GitHubService, GitHubRateLimitError } from '@server/services/githubService';
import { RATE_LIMITED_SENTINEL } from '@bike4mind/services/sreAgentService/tools';
import { apiKeyService } from '@bike4mind/services';
import {
  postSreApprovalMessage,
  postSreScopeBlockedMessage,
  postSreNoFixNeededMessage,
  postSreFixLoopMessage,
  postSreLowConfidenceMessage,
  postSreRateLimitedMessage,
  postSreAnalysisFailureMessage,
} from '@server/integrations/slack/sreSlackApproval';
import { escalateRecurrence } from '@server/integrations/sre/escalation';
import { buildWontFixCommentBody, WONT_FIX_COMMENT_MARKER } from '@server/integrations/sre/wontFixComment';

/**
 * Core analysis logic (Diagnostician), decoupled from the Lambda entrypoint so
 * it can be driven by the merged sreJobQueue handler (sreJob.dispatch) for
 * jobType: 'analysis'. Receives an already-validated payload.
 */
export async function runSreAnalysis(payload: SreEventPayload, logger: Logger): Promise<void> {
  logger.updateMetadata({ handler: 'sreAnalysis' });

  // 1. Load config
  const rawConfig = await adminSettingsRepository.getSettingsValue('sreAgentConfig');
  const config = SreAgentConfigSchema.parse(rawConfig ?? {});
  const repoSlug = payload.repoSlug ?? SRE_DEFAULT_REPO_SLUG;
  const repoConfig = resolveFullConfig(config, repoSlug);

  logger.updateMetadata({ repoSlug, fingerprint: payload.fingerprint });

  if (!repoConfig) {
    logger.warn('Repo not configured, skipping', { repoSlug });
    return;
  }

  if (!repoConfig.enabled) {
    logger.info('SRE agent disabled, skipping');
    return;
  }

  // Determine dry-run mode early: either the payload was queued as dry-run OR current config says dry-run.
  // This handles the race where config toggles between queue time and process time.
  const isDryRun = payload.dryRun || repoConfig.dryRun;

  // 2. Atomic dedup via claimForAnalysis (repo-scoped)
  const tracking = await sreErrorTrackingRepository.claimForAnalysis(payload.fingerprint, repoSlug, {
    source: payload.source,
    sourceRef: payload.logGroup || payload.issueUrl || 'unknown',
    repoSlug,
    affectedUserIds: payload.affectedUserIds || [],
    errorMessage: payload.errorMessage,
    classification: payload.classification,
    ...(payload.issueNumber != null && { githubIssueNumber: payload.issueNumber }),
    ...(isDryRun && { dryRun: true }),
  });

  if (!tracking) {
    logger.info('Duplicate fingerprint, skipping', { fingerprint: payload.fingerprint });
    return;
  }

  // 3. Circuit breaker check (per-repo)
  const cooldown = repoConfig.circuitBreaker.cooldownMinutes;
  const repoFailures = await sreErrorTrackingRepository.countConsecutiveFailures(repoSlug, cooldown);
  if (repoFailures >= repoConfig.circuitBreaker.failureThreshold) {
    logger.warn('Circuit breaker OPEN', { repoFailures });
    const cbFailureReason = `Circuit breaker open (repo: ${repoFailures} consecutive failures)`;
    await sreErrorTrackingRepository.updateStatus(tracking.id, 'failed', {
      errorMessage: cbFailureReason,
    });
    try {
      await postSreAnalysisFailureMessage(
        tracking.id,
        payload.fingerprint,
        payload.errorMessage,
        cbFailureReason,
        payload.logGroup || payload.issueUrl || 'unknown',
        repoConfig.slack ?? {}
      );
    } catch (slackErr) {
      logger.error('Failed to send circuit-breaker Slack notification (non-fatal)', { error: slackErr });
    }
    return;
  }

  // 4. Fix-loop detection (repo-scoped)
  if (await sreErrorTrackingRepository.hasRecentFixForFiles(payload.fingerprint, repoSlug)) {
    const isReopen = payload.triggerAction === 'reopened';
    logger.warn('Fix loop detected', { fingerprint: payload.fingerprint, isReopen });
    await sreErrorTrackingRepository.updateStatus(tracking.id, 'wont_fix', {
      errorMessage: isReopen
        ? 'Fix loop detected - issue was reopened after a recent fix'
        : 'Fix loop detected - recent fix exists',
    });
    // Slack notification (non-fatal)
    try {
      await postSreFixLoopMessage(
        tracking.id,
        tracking.errorMessage || payload.errorMessage || '',
        payload.fingerprint,
        tracking.githubIssueNumber,
        repoSlug,
        repoConfig.slack ?? {},
        payload.triggerAction
      );
    } catch (slackErr) {
      logger.error('Failed to send fix-loop Slack notification (non-fatal)', { error: slackErr });
    }
    // GH issue comment (non-fatal) - deduped via HTML marker (escalation.ts pattern).
    // TOCTOU note: concurrent analyses could both pass hasCommentWithMarker before either posts,
    // resulting in a duplicate comment. Blast radius is cosmetic only - fix-loop detection is
    // advisory and atomicTransition at the state level is the authoritative guard.
    if (tracking.githubIssueNumber) {
      try {
        const fixLoopGhService = await GitHubService.forSystem(logger);
        if (fixLoopGhService) {
          const alreadyPosted = await fixLoopGhService.hasCommentWithMarker(
            repoSlug,
            tracking.githubIssueNumber,
            '<!-- sre-fix-loop -->'
          );
          if (!alreadyPosted) {
            const commentBody = isReopen
              ? `<!-- sre-fix-loop -->\n**SRE Agent — Fix Loop Detected (Reopened)**\n\nThe original reporter reopened this issue after the SRE fix merged — strong signal that the prior fix did not address the root cause. Human investigation required.`
              : `<!-- sre-fix-loop -->\n**SRE Agent — Fix Loop Detected**\n\nA recent fix exists for this error fingerprint but it recurred. The prior fix may not have addressed the root cause. Human investigation required.`;
            await fixLoopGhService.addIssueComment(repoSlug, tracking.githubIssueNumber, commentBody);
          }
        }
      } catch (ghErr) {
        logger.error('Failed to post fix-loop GH comment (non-fatal)', { error: ghErr });
      }
    }
    return;
  }

  // 5. Run LLM diagnosis - get API keys using system-level (admin) keys
  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(
    'system',
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
    { logger }
  );

  // forSystem() throws for transient failures (DB error, auth init) - catch and rethrow
  // so SQS retries the message with the tracking record intact. No state update here:
  // marking as failed before rethrow would corrupt the state for the retry.
  let githubService: GitHubService | null;
  try {
    githubService = await GitHubService.forSystem(logger);
  } catch (error) {
    logger.error('GitHub service init failed (transient) — SQS will retry', {
      trackingId: tracking.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  if (!githubService) {
    logger.error('GitHub service unavailable');
    await sreErrorTrackingRepository.updateStatus(tracking.id, 'failed', {
      errorMessage: 'GitHub service unavailable',
    });
    try {
      await postSreAnalysisFailureMessage(
        tracking.id,
        payload.fingerprint,
        payload.errorMessage,
        'GitHub service unavailable',
        payload.logGroup || payload.issueUrl || 'unknown',
        repoConfig.slack ?? {}
      );
    } catch (slackErr) {
      logger.error('Failed to send GitHub-unavailable Slack notification (non-fatal)', { error: slackErr });
    }
    return;
  }

  const toolContext = {
    getFileContent: (path: string) => githubService.getFileContent(repoSlug, path),
    searchCode: async (query: string) => {
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
      const entries = await githubService.listDirectoryContents(repoSlug, path);
      return entries.map(e => e.path);
    },
    apiCallCounter: { count: 0, max: repoConfig.tokenBudget.maxGithubApiCalls },
  };

  // Pattern library adapter - lets the service check cached fixes without importing the DB layer
  const patternLookup: SrePatternLookup = {
    async findMatch(fingerprint, minConfidence) {
      const pattern = await sreErrorPatternRepository.findActiveByFingerprint(fingerprint, repoSlug, minConfidence);
      return pattern?.diagnosis ?? null;
    },
    async recordMatch(fingerprint) {
      const pattern = await sreErrorPatternRepository.findActiveByFingerprint(fingerprint, repoSlug, 0);
      if (pattern) await sreErrorPatternRepository.recordMatch(pattern.id);
    },
  };

  if (isDryRun) {
    logger.info('DRY-RUN: Config loaded', {
      step: 'config-loaded',
      fingerprint: payload.fingerprint,
      enabled: repoConfig.enabled,
      modelId: repoConfig.modelId,
      maxGithubApiCalls: repoConfig.tokenBudget.maxGithubApiCalls,
      dryRunConfig: repoConfig.dryRun,
      dryRunPayload: payload.dryRun,
      maxFixesPerDay: repoConfig.maxFixesPerDay,
    });
    logger.info('DRY-RUN: Dry-run mode resolved', {
      step: 'dry-run-resolved',
      fingerprint: payload.fingerprint,
      isDryRun: true,
      source: payload.dryRun ? 'payload' : 'config',
    });
    logger.info('DRY-RUN: Tool context setup', {
      step: 'tool-context-setup',
      fingerprint: payload.fingerprint,
      apiCallCounterMax: toolContext.apiCallCounter.max,
      repoSlug,
    });
  }

  // Fetch issue comments for GitHub issues - high-signal human triage context
  let issueComments: string | undefined;
  if (payload.source === SreSourceType.GITHUB_ISSUE && payload.issueNumber) {
    try {
      const comments = await githubService.listIssueComments(repoSlug, payload.issueNumber, 5);
      if (comments.length > 0) {
        issueComments = comments
          .map(c => {
            const author = c.author?.login ?? 'unknown';
            const date = c.created_at;
            // Sanitize: escape triple-backtick fences to prevent tool/diagnosis block injection,
            // and markdown headers to prevent fake prompt section injection
            const body = c.body.replace(/```/g, '~~~').replace(/^(#{1,6})\s/gm, '$1\u200B ');
            return `[@${author}, ${date}]: ${body}`;
          })
          .join('\n---\n')
          .slice(0, 3000);
      }
    } catch (err) {
      logger.warn('Failed to fetch issue comments, proceeding without', { error: err });
    }
  }

  // Recurrence guard (Layer 1): if this fingerprint has been auto-fixed and
  // merged N times within the window, the workaround is likely ineffective.
  // Escalate to humans for root-cause investigation instead of proposing
  // another incremental tuning.
  let priorFixHistory: Array<{ prNumber: number; mergedAt: string; proposedFix: string }> = [];
  if (repoConfig.recurrence.enabled) {
    // Single query for both Layer 1 (count gate) and Layer 2 (LLM context enrichment).
    const priorFixes = await sreErrorTrackingRepository.findMergedFixesForFingerprint(
      payload.fingerprint,
      repoConfig.recurrence.windowDays,
      repoSlug
    );
    const prNumbers = priorFixes.map(f => f.fixPrNumber).filter((n): n is number => typeof n === 'number');

    if (prNumbers.length >= repoConfig.recurrence.threshold) {
      logger.warn('[SRE-RECURRENCE] Gate fired — skipping Diagnostician LLM', {
        fingerprint: payload.fingerprint,
        priorFixCount: prNumbers.length,
        priorFixPrNumbers: prNumbers,
        windowDays: repoConfig.recurrence.windowDays,
        threshold: repoConfig.recurrence.threshold,
      });
      // Atomic CAS ensures exactly-once side-effect emission even under SQS redelivery.
      const transitioned = await sreErrorTrackingRepository.atomicTransition(
        tracking.id,
        'analyzing',
        'recurrence_detected',
        {
          priorFixPrNumbers: prNumbers,
          errorMessage: `Recurrence detected: ${prNumbers.length} prior fix(es) merged in last ${repoConfig.recurrence.windowDays} days (PRs: ${prNumbers.map(n => `#${n}`).join(', ')})`,
        }
      );
      if (transitioned) {
        await escalateRecurrence({
          trackingId: tracking.id,
          fingerprint: payload.fingerprint,
          priorFixPrNumbers: prNumbers,
          source: payload.source,
          issueNumber: payload.issueNumber,
          repoSlug,
          sourceRef: payload.issueUrl ?? payload.logGroup ?? repoSlug,
          rootCause: 'Detected by Layer 1 gate — no LLM diagnosis was generated (prior workarounds ineffective).',
          logger,
          slackConfig: repoConfig.slack,
        });
      }
      return;
    }
    // Below threshold - build history for Layer 2 LLM context enrichment.
    priorFixHistory = priorFixes
      .filter(f => typeof f.fixPrNumber === 'number' && f.fixMergedAt)
      .map(f => ({
        prNumber: f.fixPrNumber as number,
        mergedAt: (f.fixMergedAt as Date).toISOString(),
        proposedFix: f.diagnosisResult?.proposedFix ?? 'unknown',
      }));
  }

  const service = new SreAgentService(logger);
  const result = await service.diagnose(
    payload,
    repoConfig,
    apiKeyTable,
    toolContext,
    patternLookup,
    isDryRun,
    issueComments,
    undefined, // revisionContext — analysis path is always the initial flow
    priorFixHistory.length > 0 ? priorFixHistory : undefined
  );

  if (isDryRun) {
    logger.info('DRY-RUN: Diagnosis result', {
      step: 'diagnosis-result',
      fingerprint: payload.fingerprint,
      hasDiagnosis: !!result.diagnosis,
      failureReason: result.failureReason ?? null,
      confidence: result.diagnosis?.confidence ?? null,
      rootCausePreview: result.diagnosis?.rootCause?.slice(0, 200) ?? null,
      toolCallCount: result.diagnosis?.toolCalls?.length ?? 0,
      affectedFileCount: result.diagnosis?.affectedFiles?.length ?? 0,
    });
  }

  // Layer 2: LLM-emitted escalation. When the Diagnostician saw "Prior Autofix
  // History" in its prompt (below Layer 1 threshold) and judged its fix would
  // be another ineffective tuning, it sets diagnosis.escalate=true. Route to
  // the same escalation path as Layer 1.
  if (result.diagnosis?.escalate) {
    const diagnosis = result.diagnosis;
    if (priorFixHistory.length === 0) {
      logger.warn('[SRE-RECURRENCE] LLM emitted escalate=true with no prior fix history — possible hallucination', {
        fingerprint: payload.fingerprint,
        rootCauseTrackingIssue: diagnosis.rootCauseTrackingIssue ?? null,
      });
    }
    logger.warn('[SRE-RECURRENCE] LLM emitted escalate=true — skipping fix dispatch', {
      fingerprint: payload.fingerprint,
      rootCauseTrackingIssue: diagnosis.rootCauseTrackingIssue ?? null,
      priorFixHistoryCount: priorFixHistory.length,
    });
    const priorPrNumbers = priorFixHistory.map(h => h.prNumber);
    const transitioned = await sreErrorTrackingRepository.atomicTransition(
      tracking.id,
      'analyzing',
      'recurrence_detected',
      {
        diagnosisResult: diagnosis,
        priorFixPrNumbers: priorPrNumbers,
        errorMessage: `LLM escalation: ${diagnosis.rootCause.slice(0, 200)}`,
        ...(result.dryRunTrace && { dryRunTrace: result.dryRunTrace }),
      }
    );
    if (transitioned && !isDryRun) {
      await escalateRecurrence({
        trackingId: tracking.id,
        fingerprint: payload.fingerprint,
        priorFixPrNumbers: priorPrNumbers,
        rootCauseTrackingIssue: diagnosis.rootCauseTrackingIssue,
        source: payload.source,
        issueNumber: payload.issueNumber,
        repoSlug,
        sourceRef: payload.issueUrl ?? payload.logGroup ?? repoSlug,
        rootCause: diagnosis.rootCause,
        logger,
        slackConfig: repoConfig.slack,
      });
    }
    return;
  }

  if (result.scopeBlocked) {
    const { blockedFiles, diagnosis: scopeDiagnosis } = result.scopeBlocked;
    logger.info('Scope blocked — fix requires out-of-scope files', {
      fingerprint: payload.fingerprint,
      blockedFiles,
      confidence: scopeDiagnosis.confidence,
    });
    await sreErrorTrackingRepository.updateStatus(tracking.id, 'scope_blocked', {
      diagnosisResult: scopeDiagnosis,
      errorMessage: `Fix requires files outside allowed scope: ${blockedFiles.join(', ')}`,
      ...(result.dryRunTrace && { dryRunTrace: result.dryRunTrace }),
    });
    if (!isDryRun) {
      await postSreScopeBlockedMessage(
        tracking.id,
        scopeDiagnosis,
        payload.errorMessage,
        payload.fingerprint,
        blockedFiles,
        repoConfig.slack
      );
    }
    if (isDryRun) {
      logger.info('DRY-RUN: Scope blocked', {
        step: 'scope-blocked',
        fingerprint: payload.fingerprint,
        blockedFiles,
        confidence: scopeDiagnosis.confidence,
        rootCausePreview: scopeDiagnosis.rootCause?.slice(0, 200),
      });
    }
    return;
  }

  if (!result.diagnosis) {
    const diagFailureReason = result.failureReason || 'Diagnosis returned null';
    logger.warn('Diagnosis returned null', {
      fingerprint: payload.fingerprint,
      failureReason: diagFailureReason,
    });
    await sreErrorTrackingRepository.updateStatus(tracking.id, 'failed', {
      errorMessage: diagFailureReason,
      ...(result.dryRunTrace && { dryRunTrace: result.dryRunTrace }),
    });
    try {
      await postSreAnalysisFailureMessage(
        tracking.id,
        payload.fingerprint,
        payload.errorMessage,
        diagFailureReason,
        payload.logGroup || payload.issueUrl || 'unknown',
        repoConfig.slack ?? {}
      );
    } catch (slackErr) {
      logger.error('Failed to send diagnosis-null Slack notification (non-fatal)', { error: slackErr });
    }
    return;
  }

  const diagnosis = result.diagnosis;

  // 6. Update tracking with diagnosis
  await sreErrorTrackingRepository.updateStatus(tracking.id, 'analyzing', {
    diagnosisResult: diagnosis,
    ...(isDryRun && { dryRun: true }),
    ...(result.dryRunTrace && { dryRunTrace: result.dryRunTrace }),
  });

  // 6.5 Notify affected users (Concierge - Phase 1.5)
  // Skip in dry-run mode to avoid leaking side effects.
  if (!isDryRun) {
    try {
      const affectedUserIds = payload.affectedUserIds ?? [];
      if (affectedUserIds.length > 0) {
        logger.info('Notifying affected users', {
          fingerprint: payload.fingerprint,
          userCount: affectedUserIds.length,
        });
        const results = await Promise.allSettled(
          affectedUserIds.map(affectedUserId =>
            inboxRepository.createInboxMessage({
              userId: 'SYSTEM',
              receiverId: affectedUserId,
              title: 'We spotted a bug affecting you',
              message: `Our automated system detected an error that may have affected your experience: "${payload.errorMessage.slice(0, 200)}". We're investigating and will update you when a fix is ready.`,
              type: InboxType.COMMON,
            })
          )
        );
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
          logger.warn('Some user notifications failed', { failedCount: failed.length });
        }
      }
    } catch (err) {
      logger.error('Failed to notify affected users', { error: err });
    }
  }

  // 6.5b Short-circuit: no effective file changes means no code fix needed
  const effectiveFiles = diagnosis.affectedFiles.filter(f => f.before !== f.after);
  if (effectiveFiles.length === 0) {
    logger.info('[SRE-DIAGNOSTICIAN] No affected files — no fix needed', {
      fingerprint: payload.fingerprint,
      confidence: diagnosis.confidence,
      rootCause: diagnosis.rootCause?.slice(0, 200),
    });
    await sreErrorTrackingRepository.updateStatus(tracking.id, 'wont_fix', {
      errorMessage: 'Diagnosis determined no code fix is needed',
    });
    if (!isDryRun) {
      try {
        await postSreNoFixNeededMessage(
          tracking.id,
          diagnosis,
          payload.errorMessage,
          payload.fingerprint,
          payload.logGroup || payload.issueUrl || 'unknown',
          repoConfig.slack
        );
      } catch (slackErr) {
        logger.error('Failed to send no-fix-needed Slack notification (non-fatal)', { error: slackErr });
      }
      // GH issue comment - tells the issue author that analysis completed and no code fix is needed.
      // Deduped via HTML marker. TOCTOU: concurrent analyses could both pass hasCommentWithMarker
      // before either posts. Blast radius is cosmetic only - status transition is the authoritative guard.
      if (tracking.githubIssueNumber) {
        try {
          const wontFixGhService = await GitHubService.forSystem(logger);
          if (wontFixGhService) {
            const alreadyPosted = await wontFixGhService.hasCommentWithMarker(
              repoSlug,
              tracking.githubIssueNumber,
              WONT_FIX_COMMENT_MARKER
            );
            if (!alreadyPosted) {
              await wontFixGhService.addIssueComment(
                repoSlug,
                tracking.githubIssueNumber,
                buildWontFixCommentBody(diagnosis, 'initial')
              );
            }
          }
        } catch (ghErr) {
          logger.error('Failed to post wont-fix GH comment (non-fatal)', { error: ghErr });
        }
      }
    } else {
      logger.info('[DRY-RUN-TRACE]', {
        step: 'no-fix-needed',
        fingerprint: payload.fingerprint,
        confidence: diagnosis.confidence,
        affectedFilesCount: diagnosis.affectedFiles.length,
        effectiveFilesCount: 0,
      });
    }
    return;
  }

  // 7. Gate logic: diagnosticianToSurgeon
  const gate = repoConfig.gates.diagnosticianToSurgeon;
  let gateResult: 'auto' | 'ask' | 'stop' = 'auto';

  if (gate.enabled) {
    if (diagnosis.confidence >= gate.autoThreshold) {
      gateResult = 'auto';
    } else if (diagnosis.confidence >= gate.askThreshold) {
      gateResult = 'ask';
    } else {
      gateResult = 'stop';
    }
  }

  if (isDryRun) {
    logger.info('DRY-RUN: Gate evaluation', {
      step: 'gate-evaluation',
      fingerprint: payload.fingerprint,
      gateResult,
      confidence: diagnosis.confidence,
      autoThreshold: gate.autoThreshold,
      askThreshold: gate.askThreshold,
      gateEnabled: gate.enabled,
    });
    // In dry-run mode: log the gate result but always dispatch to Surgeon to exercise the full pipeline.
    logger.info('DRY-RUN: Gate result: ' + gateResult, {
      confidence: diagnosis.confidence,
      autoThreshold: gate.autoThreshold,
      askThreshold: gate.askThreshold,
    });
  } else {
    // Normal mode: apply gate logic
    if (gateResult === 'auto') {
      logger.info('Auto-proceeding to Surgeon', { confidence: diagnosis.confidence });
    } else if (gateResult === 'ask') {
      logger.info('Confidence in ASK band, requesting approval', {
        confidence: diagnosis.confidence,
      });
      await sreErrorTrackingRepository.updateStatus(tracking.id, 'awaiting_approval');
      await postSreApprovalMessage(tracking.id, diagnosis, payload.errorMessage, payload.fingerprint, repoConfig.slack);
      return;
    } else {
      logger.info('Confidence too low, stopping', { confidence: diagnosis.confidence });
      await sreErrorTrackingRepository.updateStatus(tracking.id, 'low_confidence', {
        errorMessage: `Confidence ${diagnosis.confidence}% below threshold ${gate.askThreshold}%`,
      });
      try {
        await postSreLowConfidenceMessage(
          tracking.id,
          { rootCause: diagnosis.rootCause, confidence: diagnosis.confidence },
          payload.errorMessage,
          payload.fingerprint,
          { askThreshold: gate.askThreshold },
          payload.logGroup || payload.issueUrl || 'unknown',
          repoConfig.slack
        );
      } catch (slackErr) {
        logger.error('Failed to send low-confidence Slack notification (non-fatal)', { error: slackErr });
      }
      return;
    }

    // 8. Rate limit check (per-repo - skip in dry-run)
    // Known race: read-then-check is not atomic. Two concurrent Lambdas could both pass
    // the check. Acceptable risk with small team and low concurrency.
    const repoFixesToday = await sreErrorTrackingRepository.countFixesDispatchedToday(repoSlug);
    if (repoFixesToday >= repoConfig.maxFixesPerDay) {
      logger.warn('Daily fix rate limit reached', { repoFixesToday });
      await sreErrorTrackingRepository.updateStatus(tracking.id, 'rate_limited', {
        errorMessage: `Daily fix rate limit reached (${repoFixesToday}/${repoConfig.maxFixesPerDay})`,
      });
      try {
        await postSreRateLimitedMessage(
          tracking.id,
          { rootCause: diagnosis.rootCause, confidence: diagnosis.confidence },
          payload.errorMessage,
          payload.fingerprint,
          { fixesToday: repoFixesToday, maxFixesPerDay: repoConfig.maxFixesPerDay },
          payload.logGroup || payload.issueUrl || 'unknown',
          repoConfig.slack
        );
      } catch (slackErr) {
        logger.error('Failed to send rate-limited Slack notification (non-fatal)', { error: slackErr });
      }
      return;
    }
  }

  // 9. Dispatch to sreFixQueue
  const fixRequest: SreFixRequest = {
    trackingId: tracking.id,
    fingerprint: payload.fingerprint,
    repoSlug,
    diagnosis,
    source: payload.source,
    issueNumber: payload.issueNumber,
    ...(isDryRun && { dryRun: true }),
  };

  if (isDryRun) {
    logger.info('DRY-RUN: Fix request preview', {
      step: 'fix-request-preview',
      fingerprint: payload.fingerprint,
      trackingId: tracking.id,
      source: payload.source,
      confidence: diagnosis.confidence,
      affectedFiles: diagnosis.affectedFiles.map(f => f.filePath),
    });
  }

  await sendToQueue(Resource.sreFixQueue.url, fixRequest as unknown as Record<string, unknown>);

  if (isDryRun) {
    logger.info('DRY-RUN: Queue dispatch', {
      step: 'queue-dispatch',
      fingerprint: payload.fingerprint,
      dispatched: true,
      dryRun: true,
    });
  }

  if (!isDryRun) {
    await sreErrorTrackingRepository.updateStatus(tracking.id, 'fixing', {
      dispatchedAt: new Date(),
    });
  }

  logger.info(`${isDryRun ? 'DRY-RUN: ' : ''}Dispatched to Surgeon`, {
    trackingId: tracking.id,
    confidence: diagnosis.confidence,
    dryRun: isDryRun,
  });
}
