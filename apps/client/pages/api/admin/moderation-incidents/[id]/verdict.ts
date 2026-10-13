import { z } from 'zod';
import { Request } from 'express';
import { Resource } from 'sst';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { imageModerationIncidentRepository } from '@bike4mind/database';
import { ncmecService } from '@bike4mind/services';
import { ForbiddenError } from '@server/utils/errors';

// Resolve NCMEC credentials from SST Resource (linked secrets expose Resource.X.value, not
// process.env.X). Fall back to process.env for local dev and self-host. useSandbox defaults
// to true so a missing or misconfigured value cannot post to production.
function resolveNcmecCredentials() {
  const res = Resource as unknown as Record<string, { value?: string }>;
  const espId = res.NCMEC_ESP_ID?.value ?? process.env.NCMEC_ESP_ID ?? '';
  const apiKey = res.NCMEC_API_KEY?.value ?? process.env.NCMEC_API_KEY ?? '';
  const sandboxRaw = res.NCMEC_USE_SANDBOX?.value ?? process.env.NCMEC_USE_SANDBOX;
  // Fail safe: anything other than an explicit 'false' uses the test host.
  const useSandbox = sandboxRaw !== 'false';
  return { espId, apiKey, useSandbox };
}

/**
 * Admin verdict for an image-moderation incident. Two outcomes:
 *
 *   confirmed_csam  -> submit an NCMEC CyberTip and mark the incident 'reported'.
 *   false_positive  -> mark the incident 'false_positive' (no NCMEC submission).
 *
 * Concurrency safety: `confirmed_csam` first atomically claims the incident by
 * transitioning it to 'confirmed_csam' (the intermediate state). Only one concurrent
 * request can claim a given incident; others receive 409. This prevents two simultaneous
 * operator verdicts from each submitting an independent CyberTip to NCMEC.
 *
 * The NCMEC reportId is logged immediately after NCMEC accepts the submission and before
 * the DB update so it is recoverable from logs even if the DB write subsequently fails.
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

  if (verdict === 'confirmed_csam') {
    // Atomically claim the incident: transitions pending_review/absent -> confirmed_csam.
    // Only one concurrent request can succeed; all others receive 409.
    const claimed = await imageModerationIncidentRepository.claimForNcmecSubmission(incidentId);
    if (!claimed) {
      const incident = await imageModerationIncidentRepository.findById(incidentId);
      if (!incident) return res.status(404).json({ error: 'Incident not found' });
      if (incident.reviewStatus === 'reported') return res.status(409).json({ error: 'Incident already reported to NCMEC' });
      return res.status(409).json({ error: 'Incident is already being processed or has been reviewed' });
    }

    let ncmecReportId: string;
    try {
      const result = await ncmecService.submitNcmecReport(resolveNcmecCredentials(), {
        incidentId,
        userId: claimed.userId,
        detectedAt: claimed.createdAt,
        labels: (claimed.labels ?? []).map(l => ({ name: l.name, confidence: l.confidence })),
        fabFileId: claimed.fabFileId,
      });
      ncmecReportId = result.reportId;
    } catch (err) {
      const isRejected = err instanceof ncmecService.NcmecRejectedError;
      req.logger.error(
        `[NCMEC] submission ${isRejected ? 'rejected by NCMEC' : 'unknown outcome'} for incident ${incidentId}: ${(err as Error).message}`
      );
      if (isRejected) {
        // NCMEC explicitly rejected the report (non-2xx on /submit). No CyberTip was filed,
        // so rolling back to 'pending_review' is safe: the admin can re-triage and retry.
        await imageModerationIncidentRepository
          .updateReviewStatus(incidentId, 'pending_review')
          .catch(rollbackErr =>
            req.logger.error(
              `[NCMEC] rollback to pending_review failed for incident ${incidentId}: ${(rollbackErr as Error).message}`
            )
          );
        return res.status(502).json({ error: `NCMEC rejected the report: ${(err as Error).message}` });
      }
      // Unknown outcome (timeout, network error, /finish failure, or missing reportId in 2xx
      // response). NCMEC may have already received the /submit. Do NOT roll back -- leaving the
      // incident in 'confirmed_csam' ensures a human verifies with NCMEC before re-filing.
      // Stale confirmed_csam incidents surface in the triage queue after 10 minutes.
      return res.status(502).json({
        error: `NCMEC submission outcome unknown: ${(err as Error).message}. Incident left in confirmed_csam -- verify with NCMEC before retrying.`,
      });
    }

    // Log before the DB write: if the write fails, the reportId is still recoverable from logs.
    req.logger.info(`[NCMEC] submission accepted for incident ${incidentId}, reportId=${ncmecReportId}; persisting to DB`);

    const updated = await imageModerationIncidentRepository.updateReviewStatus(incidentId, 'reported', ncmecReportId);
    if (!updated) {
      req.logger.warn(`[NCMEC] DB update skipped for incident ${incidentId} (already reported); NCMEC reportId=${ncmecReportId}`);
      return res.status(409).json({ error: 'Incident already reported to NCMEC (concurrent request)' });
    }

    req.logger.info(`[NCMEC] incident ${incidentId} marked reported, reportId=${ncmecReportId}, by admin=${req.user.id}`);
    return res.status(200).json({ ok: true, ncmecReportId });
  }

  // false_positive: no NCMEC submission, just update the status.
  const updated = await imageModerationIncidentRepository.updateReviewStatus(incidentId, 'false_positive');
  if (!updated) {
    const incident = await imageModerationIncidentRepository.findById(incidentId);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    return res.status(409).json({ error: 'Incident already reported or being processed' });
  }

  req.logger.info(`[Moderation] incident ${incidentId} marked false_positive by admin=${req.user.id}`);
  return res.status(200).json({ ok: true });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
