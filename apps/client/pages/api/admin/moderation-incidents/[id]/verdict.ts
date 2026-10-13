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
  const espEmail = res.NCMEC_ESP_EMAIL?.value ?? process.env.NCMEC_ESP_EMAIL ?? '';
  const sandboxRaw = res.NCMEC_USE_SANDBOX?.value ?? process.env.NCMEC_USE_SANDBOX;
  // Fail safe: anything other than an explicit 'false' uses the test host.
  const useSandbox = sandboxRaw !== 'false';
  return { espId, apiKey, espEmail, useSandbox };
}

function isNcmecConfigured(creds: ReturnType<typeof resolveNcmecCredentials>): boolean {
  return (
    Boolean(creds.espId) && creds.espId !== 'not-configured' &&
    Boolean(creds.apiKey) && creds.apiKey !== 'not-configured' &&
    Boolean(creds.espEmail) && creds.espEmail !== 'not-configured'
  );
}

/**
 * Admin verdict for an image-moderation incident.
 *
 * Normal verdicts (incident in pending_review/absent):
 *   confirmed_csam  -> submit an NCMEC CyberTip and mark the incident 'reported'.
 *   false_positive  -> mark the incident 'false_positive' (no NCMEC submission).
 *
 * Recovery verdicts (incident stuck in confirmed_csam after unknown NCMEC outcome):
 *   mark_reported   -> move to 'reported' with an operator-supplied ncmecReportId.
 *   requeue         -> move back to 'pending_review' after confirming with NCMEC that
 *                      no tip was filed.
 *
 * Concurrency safety: `confirmed_csam` first atomically claims the incident by
 * transitioning it to 'confirmed_csam' (the intermediate state). Only one concurrent
 * request can claim a given incident; others receive 409. This prevents two simultaneous
 * operator verdicts from each submitting an independent CyberTip to NCMEC.
 *
 * The NCMEC reportId is logged immediately after NCMEC accepts the submission and before
 * the DB update so it is recoverable from logs even if the DB write subsequently fails.
 */
const bodySchema = z.union([
  z.object({ verdict: z.literal('confirmed_csam') }),
  z.object({ verdict: z.literal('false_positive') }),
  z.object({ verdict: z.literal('mark_reported'), ncmecReportId: z.string().min(1) }),
  z.object({ verdict: z.literal('requeue') }),
]);

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(async (req: Request, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const incidentId = String(req.query.id);

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }

  const body = parsed.data;

  // Recovery paths: move a stuck confirmed_csam incident without claiming it.
  if (body.verdict === 'mark_reported') {
    const updated = await imageModerationIncidentRepository.resolveConfirmedCsam(incidentId, {
      status: 'reported',
      ncmecReportId: body.ncmecReportId,
    });
    if (!updated) return res.status(409).json({ error: 'Incident is not in confirmed_csam state' });
    req.logger.info(`[NCMEC] incident ${incidentId} manually marked reported, reportId=${body.ncmecReportId}, by admin=${req.user.id}`);
    return res.status(200).json({ ok: true, ncmecReportId: body.ncmecReportId });
  }

  if (body.verdict === 'requeue') {
    const updated = await imageModerationIncidentRepository.resolveConfirmedCsam(incidentId, {
      status: 'pending_review',
    });
    if (!updated) return res.status(409).json({ error: 'Incident is not in confirmed_csam state' });
    req.logger.info(`[Moderation] incident ${incidentId} requeued from confirmed_csam by admin=${req.user.id}`);
    return res.status(200).json({ ok: true });
  }

  if (body.verdict === 'confirmed_csam') {
    // Validate credentials before claiming the incident. If credentials are not configured
    // the service call would fail, and a plain-Error throw would strand the incident in
    // confirmed_csam with no API exit. Return 503 before the claim so the incident is
    // never moved out of pending_review in the first place.
    const credentials = resolveNcmecCredentials();
    if (!isNcmecConfigured(credentials)) {
      return res.status(503).json({ error: 'NCMEC credentials not configured -- set NCMEC_ESP_ID, NCMEC_API_KEY and NCMEC_ESP_EMAIL via sst secret set' });
    }
    if (process.env.B4M_SELF_HOST === 'true') {
      return res.status(503).json({ error: 'NCMEC reporting is not available on self-host installs' });
    }

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
      const result = await ncmecService.submitNcmecReport(credentials, {
        incidentId,
        userId: claimed.userId,
        detectedAt: claimed.createdAt,
        labels: (claimed.labels ?? []).map(l => ({ name: l.name, confidence: l.confidence })),
        fabFileId: claimed.fabFileId,
      });
      ncmecReportId = result.reportId;
    } catch (err) {
      const isRejected = err instanceof ncmecService.NcmecRejectedError;
      const isFinishFailed = err instanceof ncmecService.NcmecFinishFailedError;
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
      if (isFinishFailed) {
        // /submit succeeded -- NCMEC holds the report -- but /finish failed. Persist the
        // reportId so an admin can manually finalize within NCMEC's 24-hour window using
        // the 'mark_reported' verdict. Do NOT roll back.
        const finishErr = err as ncmecService.NcmecFinishFailedError;
        req.logger.info(`[NCMEC] /finish failed for incident ${incidentId}; persisting reportId=${finishErr.reportId} for manual recovery`);
        await imageModerationIncidentRepository
          .setNcmecReportId(incidentId, finishErr.reportId)
          .catch(persistErr =>
            req.logger.error(
              `[NCMEC] failed to persist reportId for incident ${incidentId}: ${(persistErr as Error).message}`
            )
          );
      }
      // Unknown outcome (timeout, network error, /finish failure, or missing reportId in 2xx
      // response). NCMEC may have already received the /submit. Do NOT roll back -- leaving the
      // incident in 'confirmed_csam' ensures a human verifies with NCMEC before re-filing.
      // Use 'mark_reported' or 'requeue' to resolve once verified.
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
