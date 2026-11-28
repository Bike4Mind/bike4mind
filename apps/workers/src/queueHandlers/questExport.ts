import { secureParameters } from '@bike4mind/utils';
import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import { ORG_FEEDBACK_SUMMARY_JOB_TYPE } from '@bike4mind/common';
import {
  OrgFeedbackSummaryPayload,
  runOrgFeedbackSummary,
  type CheckRunBudget,
} from '@workers/queueHandlers/orgFeedbackSummary';
import { z } from 'zod';

/**
 * The retired v4 plan export message. Nothing has produced one since the plan export route was
 * removed, and the `questmasterplans` collection it read is dropped, so a message of this shape is
 * acknowledged and discarded instead of being built into a ZIP. It still parses so a stray one is
 * consumed here rather than rejected as malformed.
 */
const RetiredPlanExportPayload = z.object({
  jobType: z.literal('questExport').optional(),
  exportJobId: z.string(),
  planId: z.string(),
  userId: z.string(),
});

/**
 * This queue now carries one live job type, the organization feedback summary. See
 * `orgFeedbackSummary.ts` for why the summary rides here instead of getting a queue of its own, and
 * for what it inherits by doing so.
 *
 * A plain union rather than `z.discriminatedUnion`, because a retired plan export message may carry
 * no `jobType` at all - a discriminated union needs the key present on every arm.
 */
const QueuePayload = z.union([OrgFeedbackSummaryPayload, RetiredPlanExportPayload]);

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body = event.Records[0].body;
  // secureParameters stays on the front of this, rather than a raw parse per arm: it is what turns
  // a malformed message into a 422 the wrapper swallows instead of a retry loop into the DLQ.
  const message = secureParameters(JSON.parse(body), QueuePayload);

  const checkBudget: CheckRunBudget = (minimumRemainingMs = 1000) => {
    if (context.getRemainingTimeInMillis() < minimumRemainingMs) throw new Error('Quest export run budget exhausted');
  };
  if (message.jobType === ORG_FEEDBACK_SUMMARY_JOB_TYPE) {
    await runOrgFeedbackSummary(message, logger, checkBudget);
    return;
  }

  // Returning (not throwing) acknowledges the message, so it is not retried into the DLQ.
  logger.warn('[questExport] Discarded a retired v4 plan export message', {
    exportJobId: message.exportJobId,
    planId: message.planId,
    userId: message.userId,
  });
});
