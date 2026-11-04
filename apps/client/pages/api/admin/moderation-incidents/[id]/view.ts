import { ApiKeyScope, ForbiddenError, NotFoundError, isFullAdmin } from '@bike4mind/common';
import { imageModerationIncidentRepository, userRepository } from '@bike4mind/database';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { adminApi } from '@server/middlewares/adminApi';
import { requireStepUp } from '@server/auth/stepUp';
import { signIncidentImage } from '@server/moderation/incidentImageLink';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

/**
 * One reviewer view of an image moderation incident: who and what was flagged (the user, the
 * classifier labels, provider/model and the ids it was produced under) and, when a stored image exists,
 * a link that works for five minutes. Full admins on a freshly verified session only. The view is
 * audited before the link is signed, so a view that cannot be recorded never yields an image, and
 * the response is never cached.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'users:moderate' },
}).get(async (req, res) => {
  // Delegated admins are not reviewers: they must not see the images.
  if (!isFullAdmin(req.user)) throw new ForbiddenError('Admin access required');
  await requireStepUp(req);

  const incidentId = req.query.id;
  const incident = isValidObjectId(incidentId) ? await imageModerationIncidentRepository.findById(incidentId) : null;
  if (!incident) throw new NotFoundError('Incident not found');

  await recordAdminActionFromRequest(req, {
    action: 'moderation.incident.viewed',
    target: { kind: 'system', id: incident.id, displayName: 'image moderation incident' },
    summary: `viewed moderation incident ${incident.id}`,
    details: { incidentId: incident.id },
  });

  const [image, user] = await Promise.all([
    signIncidentImage(incident),
    isValidObjectId(incident.userId) ? userRepository.findById(incident.userId) : null,
  ]);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    id: incident.id,
    createdAt: incident.createdAt,
    surface: incident.surface ?? null,
    reviewStatus: incident.reviewStatus ?? 'pending_review',
    previousReviewStatus: incident.previousReviewStatus ?? null,
    // A deleted account keeps its id on the incident; email is null then.
    user: { id: incident.userId, email: user?.email ?? null },
    labels: (incident.labels ?? []).map(({ name, parentName, confidence }) => ({ name, parentName, confidence })),
    provider: incident.provider,
    model: incident.model,
    sessionId: incident.sessionId ?? null,
    questId: incident.questId ?? null,
    fabFileId: incident.fabFileId ?? null,
    ncmecReportId: incident.ncmecReportId ?? null,
    alertedAt: incident.alertedAt ?? null,
    lastReminderAt: incident.lastReminderAt ?? null,
    reportedAt: incident.reportedAt ?? null,
    falsePositiveAt: incident.falsePositiveAt ?? null,
    image,
  });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
