/**
 * PATCH /api/v1/briefs/{id}/decisions/{decisionId} - edit a follow-up decision while it is pending. JWT only;
 * shared lookup and 404/409 rules in apps/client/server/briefs/followUpDecision.ts.
 */
import { BadRequestError, editBriefDecisionContract } from '@bike4mind/common';
import { assistantBriefRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { decisionClosed, loadPendingFollowUp, readSerializedDecision } from '@server/briefs/followUpDecision';

const editRoute = nextRouteForContract(editBriefDecisionContract, {
  rateLimit: perUserRateLimit('PATCH /api/v1/briefs/[id]/decisions/[decisionId]'),
}).patch(async (req, res) => {
  const { id: briefId, decisionId } = req.validatedParams;
  const { text, draftReply, remindAt } = req.validated;
  const userId = req.user.id;

  const { decision, followUp } = await loadPendingFollowUp(briefId, userId, decisionId);
  if (draftReply && followUp.kind !== 'followUpEmail') {
    throw new BadRequestError('draftReply applies only to a follow-up email.');
  }
  if (remindAt !== undefined && followUp.kind !== 'reminder') {
    throw new BadRequestError('remindAt applies only to a reminder.');
  }
  if (draftReply && !decision.draftReply && !(draftReply.to && draftReply.subject && draftReply.body)) {
    throw new BadRequestError('This follow-up email has no draft yet; send to, subject and body together.');
  }

  const edited = await assistantBriefRepository.editFollowUpDecision(briefId, userId, decisionId, {
    text,
    draftReply,
    remindAt: remindAt === undefined ? undefined : new Date(remindAt),
  });
  if (!edited) throw decisionClosed();
  return res.status(200).json(await readSerializedDecision(briefId, userId, decisionId));
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ PATCH: editRoute });
