import { Request } from 'express';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { requireStepUp } from '@server/auth/stepUp';
import { imageModerationIncidentRepository, withTransaction } from '@bike4mind/database';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { sendIncidentEscalationAlert } from '@bike4mind/server-utils/moderation/imageModerationIncidents';
import {
  parseAdminActionReason,
  recordAdminActionFromRequest,
  userAuditTarget,
} from '@bike4mind/server-utils/utils/adminAudit';

/**
 * Moves a pending image moderation incident to the second review step. The escalation stamps and
 * the audit entry (with the reviewer's reason) commit together; the incident stays pending. The
 * escalation email goes out after the commit and never fails the request: `alert` says whether it
 * was delivered, found no escalation reviewer, or failed, and the review sweep retries an
 * undelivered one.
 */
const handler = adminApi({
  // A step-up lives on a signed-in session, so an API key could never satisfy it.
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'users:moderate' },
}).post(async (req: Request, res) => {
  await requireStepUp(req);
  const reason = parseAdminActionReason(req.body?.reason);

  const incidentId = req.query.id;
  if (!isValidObjectId(incidentId)) return res.status(404).json({ error: 'Incident not found' });

  const adminId = req.user.id;
  const escalated = await withTransaction(async () => {
    const updated = await imageModerationIncidentRepository.escalate(incidentId, { trigger: 'manual', by: adminId });
    if (updated) {
      // Targets the flagged user, like the verdict entries, so an account's moderation history is filterable.
      await recordAdminActionFromRequest(req, {
        action: 'moderation.incident.escalated',
        target: await userAuditTarget(updated.userId),
        summary: `escalated moderation incident ${incidentId}`,
        reason,
        details: { incidentId, trigger: 'manual' },
      });
    }
    return updated;
  });
  if (!escalated) {
    const incident = await imageModerationIncidentRepository.findById(incidentId);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    const pending = !incident.reviewStatus || incident.reviewStatus === 'pending_review';
    return res.status(409).json({
      error: pending ? 'Incident is already escalated' : `Incident is already ${incident.reviewStatus}`,
    });
  }

  const alert = await sendIncidentEscalationAlert({
    id: incidentId,
    createdAt: escalated.createdAt,
    surface: escalated.surface,
  });
  req.logger.info(
    `[Moderation] incident ${incidentId} escalated by admin=${adminId}; escalation alert ${alert.outcome}`
  );
  return res.status(200).json({
    ok: true,
    incident: {
      id: incidentId,
      reviewStatus: escalated.reviewStatus ?? 'pending_review',
      escalatedAt: escalated.escalatedAt,
      escalationTrigger: escalated.escalationTrigger,
      escalationAlertedAt: alert.alertedAt,
      escalationAlertQueuedAt: alert.queuedAt,
    },
    alert: alert.outcome,
  });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
