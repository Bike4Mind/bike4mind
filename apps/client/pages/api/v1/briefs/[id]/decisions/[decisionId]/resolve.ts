/**
 * POST /api/v1/briefs/{id}/decisions/{decisionId}/resolve - approve or dismiss a pending follow-up, once.
 * Approval only records the decision: an approved email is handed to the device mail app by the client and
 * never sent from here. JWT only; shared lookup and 404/409 rules in apps/client/server/briefs/followUpDecision.ts.
 */
import { BadRequestError, resolveBriefDecisionContract } from '@bike4mind/common';
import { assistantBriefRepository, userRepository } from '@bike4mind/database';
import { z } from 'zod';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { decisionClosed, loadPendingFollowUp, readSerializedDecision } from '@server/briefs/followUpDecision';

const isEmailAddress = (value: string) => z.email().safeParse(value).success;

const route = nextRouteForContract(resolveBriefDecisionContract, {
  rateLimit: perUserRateLimit('POST /api/v1/briefs/[id]/decisions/[decisionId]/resolve'),
}).post(async (req, res) => {
  const { id: briefId, decisionId } = req.validatedParams;
  const { outcome } = req.validated;
  const userId = req.user.id;

  const { decision, followUp } = await loadPendingFollowUp(briefId, userId, decisionId);
  if (outcome === 'approve') {
    if (followUp.kind === 'followUpEmail' && !(decision.draftReply && isEmailAddress(decision.draftReply.to))) {
      throw new BadRequestError('Set the recipient to an email address before approving this email.');
    }
    if (followUp.kind === 'reminder' && !followUp.remindAt) {
      throw new BadRequestError('Set a time before approving this reminder.');
    }
  }

  const state = outcome === 'approve' ? 'approved' : 'dismissed';
  // Pins the recipient and time validated above, so an edit racing this approval cannot slip past them.
  const expected =
    state !== 'approved'
      ? {}
      : followUp.kind === 'followUpEmail'
        ? { to: decision.draftReply?.to }
        : followUp.kind === 'reminder'
          ? { remindAt: followUp.remindAt ?? undefined }
          : {};
  if (
    !(await assistantBriefRepository.resolveFollowUpDecision(briefId, userId, decisionId, state, new Date(), expected))
  ) {
    throw decisionClosed();
  }

  if (state === 'approved' && followUp.kind === 'reminder' && followUp.remindAt) {
    // Best effort: without the pull-forward the reminder still lands in the next brief composed after it.
    await userRepository.pullNextBriefAtForward(userId, followUp.remindAt).catch((error: unknown) => {
      req.logger.warn('[briefs] Reminder approved but moving the next scheduled brief earlier failed', {
        briefId,
        decisionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return res.status(200).json(await readSerializedDecision(briefId, userId, decisionId));
});

export const config = {
  api: { externalResolver: true },
};

export default route;
