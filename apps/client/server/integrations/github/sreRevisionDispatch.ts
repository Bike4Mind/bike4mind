/**
 * SRE Revision Dispatch - Shared Logic
 *
 * Extracted from PullRequestReviewHandler.handleSreRevisionRequest() so both the
 * org-level webhook flow (processOrgWebhook) and the dedicated /api/webhooks/github/sre
 * endpoint can trigger SRE revision cycles independently.
 *
 * Mirrors the pattern in sreWebhookDispatch.ts: Zod validation at trust boundary,
 * config check, dedup, atomic claim, SQS dispatch.
 */

import { Logger } from '@bike4mind/observability';
import {
  SreAgentConfigSchema,
  SreSourceType,
  resolveFullConfig,
  type SreRevisionRequest,
  type SreJobType,
} from '@bike4mind/common';
import { adminSettingsRepository, cacheRepository, sreErrorTrackingRepository } from '@bike4mind/database';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { sendToQueue } from '@server/utils/sqs';
import { postSreRevisionEscalationMessage } from '@server/integrations/slack/sreSlackApproval';
import { z } from 'zod';

/** Dedup window for PR-number-based dispatch dedup (1 hour, matches issue dispatch). */
const SRE_REVISION_DEDUP_WINDOW_MS = 60 * 60 * 1000;

/** Branch name must match safe characters to prevent injection downstream. */
const SRE_BRANCH_NAME_REGEX = /^sre-fix\/[a-zA-Z0-9._-]+$/;

/**
 * Zod schema for validating the GitHub pull_request_review payload fields we depend on.
 * Used at the trust boundary (webhook endpoint / queue handler) to catch shape mismatches.
 *
 * Intentionally strict: only accepts action=submitted + state=changes_requested
 * to reject irrelevant events as early as possible.
 */
export const SrePullRequestReviewPayloadSchema = z.object({
  action: z.literal('submitted'),
  review: z.object({
    state: z.literal('changes_requested'),
    body: z.string().max(4000).nullish(),
    user: z.object({ login: z.string() }),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    head: z.object({ ref: z.string() }),
    html_url: z.string(),
    user: z.object({ login: z.string() }),
  }),
  repository: z.object({ full_name: z.string() }).optional(),
});

export type SrePullRequestReviewPayload = z.infer<typeof SrePullRequestReviewPayloadSchema>;

export interface SreRevisionDispatchResult {
  dispatched: boolean;
  reason?: string;
}

/**
 * Dispatch a pull_request_review event to the SRE revision queue if it matches
 * an sre-fix/* branch with a tracked fix. Loads config from adminSettings.
 *
 * Safe to call from multiple entry points (sre.ts, processOrgWebhook):
 * PR-number-level dedup + claimRevision CAS prevent double dispatch.
 *
 * @param payload - Raw webhook payload (validated via Zod internally)
 * @param logger - Optional logger instance
 */
export async function dispatchReviewToSreRevision(
  payload: Record<string, unknown>,
  logger?: Logger
): Promise<SreRevisionDispatchResult> {
  // 1. Validate payload shape at trust boundary
  const parseResult = SrePullRequestReviewPayloadSchema.safeParse(payload);
  if (!parseResult.success) {
    // Not a matching event (wrong action, state, or shape) - expected for most PR reviews
    return { dispatched: false, reason: 'payload-mismatch' };
  }

  const review = parseResult.data;
  const branchName = review.pull_request.head.ref;
  const prNumber = review.pull_request.number;

  // 2. Branch name must be an sre-fix/* branch
  if (!branchName.startsWith('sre-fix/')) {
    return { dispatched: false, reason: 'not-sre-branch' };
  }

  // 3. Validate branch name characters to prevent injection
  if (!SRE_BRANCH_NAME_REGEX.test(branchName)) {
    logger?.warn('[SRE-REVISION] Branch name contains invalid characters', { branchName, prNumber });
    return { dispatched: false, reason: 'invalid-branch-name' };
  }

  logger?.info('[SRE-REVISION] Detected changes_requested on SRE fix branch', {
    branchName,
    prNumber,
    reviewer: review.review.user.login,
  });

  // 4. Load SRE config
  const rawConfig = await adminSettingsRepository.getSettingsValue('sreAgentConfig');
  const config = SreAgentConfigSchema.parse(rawConfig ?? {});

  const repoSlug = review.repository?.full_name;
  const repoConfig = resolveFullConfig(config, repoSlug ?? '');

  if (!repoConfig) {
    logger?.info('[SRE-REVISION] Repo not configured, skipping revision');
    return { dispatched: false, reason: 'repo-not-configured' };
  }

  if (!repoConfig.enabled) {
    return { dispatched: false, reason: 'repo-disabled' };
  }

  if (repoConfig.maxRevisions === 0) {
    logger?.info('[SRE-REVISION] Revisions disabled (maxRevisions=0), skipping');
    return { dispatched: false, reason: 'revisions-disabled' };
  }

  // 5. PR-number-level dedup: prevents double dispatch when the same review
  //    arrives via both the SRE endpoint (sre.ts) and the org webhook path.
  const dedupKey = `sre-revision-${repoSlug}-${prNumber}`;
  const dedupResult = await cacheRepository.incrementCounterConditional(dedupKey, 1, SRE_REVISION_DEDUP_WINDOW_MS);
  if (!dedupResult.success) {
    logger?.info('[SRE-REVISION] Review already dispatched (PR-number dedup)', { prNumber });
    return { dispatched: false, reason: 'already-dispatched' };
  }

  // 6. Look up tracking document by PR number
  const tracking = await sreErrorTrackingRepository.findByPrNumber(prNumber, repoSlug);
  if (!tracking) {
    logger?.warn('[SRE-REVISION] No tracking document found for PR', { prNumber });
    return { dispatched: false, reason: 'no-tracking-doc' };
  }

  if (!tracking.diagnosisResult) {
    logger?.warn('[SRE-REVISION] Tracking document has no diagnosis result', { trackingId: tracking.id });
    return { dispatched: false, reason: 'no-diagnosis' };
  }

  // 7. Atomic claim: fixed -> revision_requested (handles dupes, cap, merged-PR guard)
  const claimed = await sreErrorTrackingRepository.claimRevision(tracking.id, repoConfig.maxRevisions);

  if (!claimed) {
    // Check if we hit the revision cap - if so, escalate to human
    const refreshed = await sreErrorTrackingRepository.findByPrNumber(prNumber, repoSlug);
    if (refreshed && (refreshed.revisionCount ?? 0) >= repoConfig.maxRevisions) {
      logger?.warn('[SRE-REVISION] Max revisions reached, escalating to human', {
        trackingId: tracking.id,
        revisionCount: refreshed.revisionCount,
        maxRevisions: repoConfig.maxRevisions,
      });
      try {
        await postSreRevisionEscalationMessage(
          tracking.id,
          tracking.errorFingerprint,
          review.pull_request.html_url,
          refreshed.revisionCount ?? 0,
          review.review.body ?? 'No feedback provided',
          repoConfig.slack ?? {}
        );
      } catch (slackErr) {
        logger?.error('[SRE-REVISION] Failed to post escalation message (non-fatal)', { error: slackErr });
      }
      return { dispatched: false, reason: 'max-revisions-reached' };
    }

    logger?.info('[SRE-REVISION] Claim failed — revision already in progress or PR merged', {
      trackingId: tracking.id,
      status: refreshed?.status,
    });
    return { dispatched: false, reason: 'claim-failed' };
  }

  // 8. Store reviewer feedback for audit trail
  await sreErrorTrackingRepository.updateStatus(claimed.id, 'revision_requested', {
    reviewerFeedback: (review.review.body ?? '').slice(0, 4000),
  });

  // 9. Enqueue revision request - heavy LLM work happens in the sreRevision queue handler
  const revisionRequest: SreRevisionRequest = {
    trackingId: claimed.id,
    fingerprint: claimed.errorFingerprint,
    repoSlug: claimed.repoSlug,
    branchName,
    prNumber,
    reviewBody: review.review.body ?? undefined,
    originalDiagnosis: claimed.diagnosisResult!,
    source: claimed.source as SreSourceType,
    issueNumber: claimed.githubIssueNumber,
  };

  await sendToQueue(getSourceQueueUrl('sreJobQueue'), {
    ...revisionRequest,
    jobType: 'revision' satisfies SreJobType,
  } as unknown as Record<string, unknown>);

  logger?.info('[SRE-REVISION] Revision request enqueued', {
    trackingId: claimed.id,
    branchName,
    prNumber,
    revisionCount: claimed.revisionCount,
  });

  return { dispatched: true };
}
