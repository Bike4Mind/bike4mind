import { z } from 'zod';
import { Request } from 'express';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { imageModerationIncidentRepository } from '@bike4mind/database';
import { ncmecService } from '@bike4mind/services';
import { ForbiddenError } from '@server/utils/errors';

/**
 * Admin verdict for an image-moderation incident. Two outcomes:
 *
 *   confirmed_csam  -> submit an NCMEC CyberTip and mark the incident 'reported'.
 *   false_positive  -> mark the incident 'false_positive' (no NCMEC submission).
 *
 * The NCMEC submission is idempotent: `updateReviewStatus` uses a `$ne: 'reported'`
 * guard, so a duplicate POST after a successful submission returns 409 rather than
 * re-submitting to NCMEC.
 */
const bodySchema = z.object({
  verdict: z.enum(['confirmed_csam', 'false_positive']),
});

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(async (req: Request, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const incidentId = String(req.query.id);

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }

  const { verdict } = parsed.data;

  const incident = await imageModerationIncidentRepository.findById(incidentId);
  if (!incident) {
    return res.status(404).json({ error: 'Incident not found' });
  }

  if (verdict === 'confirmed_csam') {
    if (incident.reviewStatus === 'reported') {
      return res.status(409).json({ error: 'Incident already reported to NCMEC' });
    }

    let ncmecReportId: string;
    try {
      const result = await ncmecService.submitNcmecReport({
        incidentId,
        userId: incident.userId,
        detectedAt: incident.createdAt,
        labels: (incident.labels ?? []).map(l => ({ name: l.name, confidence: l.confidence })),
        fabFileId: incident.fabFileId,
      });
      ncmecReportId = result.reportId;
    } catch (err) {
      req.logger.error(`[NCMEC] submission failed for incident ${incidentId}: ${(err as Error).message}`);
      return res.status(502).json({ error: `NCMEC submission failed: ${(err as Error).message}` });
    }

    const updated = await imageModerationIncidentRepository.updateReviewStatus(incidentId, 'reported', ncmecReportId);
    if (!updated) {
      // Race: another request already flipped it to 'reported' between our fetch and update.
      return res.status(409).json({ error: 'Incident already reported to NCMEC (concurrent request)' });
    }

    req.logger.info(`[NCMEC] reported incident ${incidentId} -> reportId ${ncmecReportId} by admin=${req.user.id}`);
    return res.status(200).json({ ok: true, ncmecReportId });
  }

  // false_positive: no NCMEC submission, just update the status.
  const updated = await imageModerationIncidentRepository.updateReviewStatus(incidentId, 'false_positive');
  if (!updated) {
    return res.status(404).json({ error: 'Incident not found or already reported' });
  }

  req.logger.info(`[Moderation] incident ${incidentId} marked false_positive by admin=${req.user.id}`);
  return res.status(200).json({ ok: true });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
