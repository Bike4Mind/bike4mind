/**
 * SRE fix PR tracking: on a merged sre-fix/* PR, mark the tracking doc fixed and notify
 * affected users; on a verdict label, record the human verdict.
 *
 * Called only from the system SRE webhook (/api/webhooks/github/sre), whose signature is
 * verified with the operator's per-repo SRE secret. Tenant GitHub webhooks (org and MCP
 * server) never reach this, so tracking docs only change on operator-signed events.
 */

import { Logger } from '@bike4mind/observability';
import { InboxType } from '@bike4mind/common';
import { inboxRepository, sreErrorTrackingRepository } from '@bike4mind/database';
import { z } from 'zod';

/** Labels a human applies to an SRE fix PR to record whether the fix was correct. */
const SRE_FIX_VERDICT_LABELS: Record<string, 'correct' | 'incorrect'> = {
  'sre-fix-correct': 'correct',
  'sre-fix-incorrect': 'incorrect',
};

const SRE_FIX_BRANCH_PREFIX = 'sre-fix/';

export const SrePullRequestPayloadSchema = z.object({
  action: z.string(),
  label: z.object({ name: z.string() }).nullish(),
  sender: z.object({ login: z.string() }).nullish(),
  pull_request: z.object({
    number: z.number().int().positive(),
    merged: z.boolean().nullish(),
    head: z.object({ ref: z.string() }),
  }),
  repository: z.object({ full_name: z.string().min(1) }),
});

export type SrePullRequestPayload = z.infer<typeof SrePullRequestPayloadSchema>;

export interface SrePullRequestTrackingResult {
  recorded: boolean;
  reason?: string;
}

export async function recordSrePullRequestEvent(
  rawPayload: unknown,
  logger: Logger
): Promise<SrePullRequestTrackingResult> {
  const parsed = SrePullRequestPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) return { recorded: false, reason: 'invalid_payload' };

  const payload = parsed.data;
  if (!payload.pull_request.head.ref.startsWith(SRE_FIX_BRANCH_PREFIX)) {
    return { recorded: false, reason: 'not_sre_branch' };
  }

  if (payload.action === 'closed' && payload.pull_request.merged) {
    return recordMerged(payload, logger);
  }
  if (payload.action === 'labeled') {
    return recordVerdict(payload, logger);
  }
  return { recorded: false, reason: 'unsupported_action' };
}

async function recordMerged(payload: SrePullRequestPayload, logger: Logger): Promise<SrePullRequestTrackingResult> {
  const prNumber = payload.pull_request.number;
  const repo = payload.repository.full_name;

  try {
    const tracking = await sreErrorTrackingRepository.findByPrNumber(prNumber, repo);
    if (!tracking || !tracking.affectedUserIds?.length) {
      return { recorded: false, reason: 'no_tracking_doc' };
    }

    logger.info('[SRE-CONCIERGE] SRE fix merged, notifying affected users', {
      prNumber,
      repo,
      userCount: tracking.affectedUserIds.length,
    });
    await Promise.allSettled(
      tracking.affectedUserIds.map(affectedUserId =>
        inboxRepository.createInboxMessage({
          userId: 'SYSTEM',
          receiverId: affectedUserId,
          title: 'Bug fix deployed for an issue affecting you',
          message: `A fix for "${tracking.errorMessage?.slice(0, 200) || 'a production error'}" has been merged. The issue should be resolved shortly.`,
          type: InboxType.COMMON,
        })
      )
    );
    await sreErrorTrackingRepository.updateStatus(tracking.id, 'fixed', {
      fixMergedAt: new Date(),
      userNotifiedAt: new Date(),
    });
    return { recorded: true };
  } catch (err) {
    logger.error('[SRE-CONCIERGE] Failed to process SRE fix merge notification', { prNumber, error: err });
    return { recorded: false, reason: 'error' };
  }
}

async function recordVerdict(payload: SrePullRequestPayload, logger: Logger): Promise<SrePullRequestTrackingResult> {
  const labelName = payload.label?.name;
  const value = labelName ? SRE_FIX_VERDICT_LABELS[labelName] : undefined;
  if (!value) return { recorded: false, reason: 'not_verdict_label' };

  const prNumber = payload.pull_request.number;
  const by = payload.sender?.login || 'unknown';

  try {
    // PR numbers are unique per repo, so the lookup is scoped by repo slug.
    const updated = await sreErrorTrackingRepository.setFixVerdict(
      prNumber,
      { value, by, at: new Date() },
      payload.repository.full_name
    );
    if (!updated) {
      logger.info('[SRE-VERDICT] No tracking doc for SRE PR, verdict skipped', { prNumber, labelName });
      return { recorded: false, reason: 'no_tracking_doc' };
    }
    logger.info('[SRE-VERDICT] Recorded fix verdict', { prNumber, value, by, trackingId: updated.id });
    return { recorded: true };
  } catch (err) {
    logger.error('[SRE-VERDICT] Failed to record fix verdict', { prNumber, labelName, error: err });
    return { recorded: false, reason: 'error' };
  }
}
