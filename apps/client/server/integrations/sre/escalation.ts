/**
 * SRE Agent - Recurrence escalation side effects.
 *
 * Shared helper used by both:
 *   1. The deterministic Layer 1 gate in sreAnalysis.ts when a fingerprint has
 *      ≥ threshold prior merged autofixes within the window.
 *   2. The Layer 2 LLM path when the Diagnostician emits `escalate: true` in
 *      its diagnosis.
 *
 * Side effects (each independently wrapped - failure of one does not prevent
 * the other):
 *   - Post a comment on the originating GitHub issue citing prior PRs and the
 *     root-cause tracking issue (best effort; only when source=GITHUB_ISSUE).
 *   - Post a Slack alert to the SRE channel.
 *   - Deactivate the matched pattern-library entry so the cached workaround
 *     is not re-used on future occurrences.
 *
 * Exactly-once semantics: callers invoke this helper ONLY after a successful
 * `atomicTransition(id, 'analyzing', 'recurrence_detected', ...)` CAS, which
 * guarantees a single execution per tracking doc even under SQS redelivery.
 */

import { Logger } from '@bike4mind/observability';
import { SreSourceType, type SreRepoConfig } from '@bike4mind/common';
import { sreErrorPatternRepository } from '@bike4mind/database';
import { GitHubService } from '@server/services/githubService';
import { postSreRecurrenceDetectedMessage } from '@server/integrations/slack/sreSlackApproval';

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

export interface EscalateRecurrenceInput {
  trackingId: string;
  fingerprint: string;
  priorFixPrNumbers: number[];
  rootCauseTrackingIssue?: number;
  /** Originating error source (GITHUB_ISSUE enables the issue-comment side effect). */
  source: SreSourceType;
  /** GitHub issue number on the source repo, when `source === 'GITHUB_ISSUE'`. */
  issueNumber?: number;
  /** `owner/repo` the autofix operates on. */
  repoSlug: string;
  /** Source reference URL (GH issue URL or CloudWatch log group) for operator triage. */
  sourceRef: string;
  /** Root-cause summary from the latest diagnosis, for the Slack message. */
  rootCause: string;
  logger: Logger;
  slackConfig: SreRepoConfig['slack'];
}

export async function escalateRecurrence(input: EscalateRecurrenceInput): Promise<void> {
  const {
    trackingId,
    fingerprint,
    priorFixPrNumbers,
    rootCauseTrackingIssue,
    source,
    issueNumber,
    repoSlug,
    sourceRef,
    rootCause,
    logger,
    slackConfig,
  } = input;

  // Structured log line for CloudWatch Metric Filters / dashboards.
  logger.warn('[SRE-RECURRENCE] recurrence_detected', {
    event: 'recurrence_detected',
    trackingId,
    fingerprint,
    priorFixCount: priorFixPrNumbers.length,
    priorFixPrNumbers,
    rootCauseTrackingIssue,
  });

  // Side effect 1: deactivate the pattern library entry so the ineffective
  // workaround is not reused. Best-effort - `findActiveByFingerprint` may
  // return null if upsertFromFix never ran for this fingerprint.
  try {
    const pattern = await sreErrorPatternRepository.findActiveByFingerprint(fingerprint, repoSlug, 0);
    if (pattern) {
      await sreErrorPatternRepository.update({
        id: pattern.id,
        isActive: false,
        workaroundIneffective: true,
        ...(rootCauseTrackingIssue !== undefined ? { rootCauseTrackingIssue } : {}),
      });
      logger.info('[SRE-RECURRENCE] Deactivated pattern entry', { patternId: pattern.id, fingerprint });
    }
  } catch (patternError) {
    logger.error('[SRE-RECURRENCE] Failed to deactivate pattern (non-fatal)', {
      error: serializeError(patternError),
      fingerprint,
    });
  }

  // Side effect 2: post a GitHub issue comment (only for GITHUB_ISSUE source).
  // Idempotency: check for an existing comment with the escalation marker before
  // posting. Prevents duplicate comments if an operator retries the fingerprint
  // and the recurrence guard fires again on a subsequent occurrence.
  const ESCALATION_MARKER = '<!-- sre-recurrence-escalation -->';
  if (source === SreSourceType.GITHUB_ISSUE && issueNumber) {
    try {
      const githubService = await GitHubService.forSystem(logger);
      if (githubService) {
        const alreadyPosted = await githubService.hasCommentWithMarker(repoSlug, issueNumber, ESCALATION_MARKER);
        if (alreadyPosted) {
          logger.info('[SRE-RECURRENCE] Escalation comment already exists, skipping duplicate', {
            repoSlug,
            issueNumber,
          });
        } else {
          const prLinksMd = priorFixPrNumbers.map(n => `#${n}`).join(', ');
          const rootCauseLine = rootCauseTrackingIssue
            ? `**Root-cause investigation:** #${rootCauseTrackingIssue}`
            : `**Root-cause investigation:** _not yet linked_ — please create a tracking issue and link it via \`PATCH /api/sre/patterns/[id]\`.`;
          const body = [
            ESCALATION_MARKER,
            '## SRE Agent — Workaround Ineffective',
            '',
            `This error has recurred after ${priorFixPrNumbers.length} prior autofix PR(s) were merged (${prLinksMd}). Further incremental tuning is likely to be ineffective — escalating for root-cause investigation.`,
            '',
            rootCauseLine,
            '',
            `**Tracking ID:** \`${trackingId}\``,
            '',
            '_If you believe this is unrelated to the prior fixes, an admin can override via the SRE admin UI (Retry) or by PATCHing the pattern entry to clear `workaroundIneffective`._',
          ].join('\n');
          await githubService.addIssueComment(repoSlug, issueNumber, body);
          logger.info('[SRE-RECURRENCE] Posted escalation comment on issue', { repoSlug, issueNumber });
        }
      }
    } catch (githubError) {
      logger.error('[SRE-RECURRENCE] Failed to post GitHub escalation comment (non-fatal)', {
        error: serializeError(githubError),
        trackingId,
        issueNumber,
      });
    }
  }

  // Side effect 3: post Slack alert.
  try {
    await postSreRecurrenceDetectedMessage(
      trackingId,
      fingerprint,
      priorFixPrNumbers,
      repoSlug,
      rootCauseTrackingIssue,
      rootCause,
      sourceRef,
      slackConfig ?? {}
    );
  } catch (slackError) {
    logger.error('[SRE-RECURRENCE] Failed to post Slack escalation (non-fatal)', {
      error: serializeError(slackError),
      trackingId,
    });
  }
}
