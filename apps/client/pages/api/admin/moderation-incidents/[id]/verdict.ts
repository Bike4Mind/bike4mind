import { z } from 'zod';
import { Request } from 'express';
import { Resource } from 'sst';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { imageModerationIncidentRepository, withTransaction } from '@bike4mind/database';
import { ncmecService } from '@bike4mind/services';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

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
    Boolean(creds.espId) &&
    creds.espId !== 'not-configured' &&
    Boolean(creds.apiKey) &&
    creds.apiKey !== 'not-configured' &&
    Boolean(creds.espEmail) &&
    creds.espEmail !== 'not-configured'
  );
}

/**
 * Admin verdict for an image-moderation incident.
 *
 * Normal verdicts (incident in pending_review/absent):
 *   confirmed_csam  -> submit an NCMEC CyberTip and mark the incident 'reported'.
 *   false_positive  -> mark the incident 'false_positive' (no NCMEC submission).
 *   record_manual_report -> the admin filed the CyberTip by hand on the NCMEC web form; mark
 *                      the incident 'reported' with that report id. Needs no NCMEC API
 *                      credentials, so it works before ESP API access is provisioned. Also
 *                      overrides a 'false_positive' verdict, since the tip already exists.
 *
 * Recovery verdicts (incident stuck in confirmed_csam after unknown NCMEC outcome; only
 * claims older than STALE_CONFIRMED_CSAM_MS are resolvable, so a live submission is safe):
 *   mark_reported   -> move to 'reported' with an operator-supplied ncmecReportId.
 *   requeue         -> move back to 'pending_review' after confirming with NCMEC that
 *                      no tip was filed. Refused when an ncmecReportId is stored.
 *   retry_finish    -> re-call /finish for a stored ncmecReportId (NCMEC deletes an
 *                      unfinished report 24h after /submit); no stale wait.
 *
 * Concurrency safety: `confirmed_csam` first atomically claims the incident by
 * transitioning it to 'confirmed_csam' (the intermediate state). Only one concurrent
 * request can claim a given incident; others receive 409. This prevents two simultaneous
 * operator verdicts from each submitting an independent CyberTip to NCMEC.
 *
 * The NCMEC reportId is logged immediately after NCMEC accepts the submission and before
 * the DB update so it is recoverable from logs even if the DB write subsequently fails.
 */
// An operator-typed CyberTip id; the charset also keeps CR/LF out of the [NCMEC] log lines.
const ncmecReportIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/);

const bodySchema = z.union([
  z.object({ verdict: z.literal('confirmed_csam') }),
  z.object({ verdict: z.literal('false_positive') }),
  z.object({ verdict: z.literal('mark_reported'), ncmecReportId: ncmecReportIdSchema }),
  z.object({ verdict: z.literal('requeue') }),
  z.object({ verdict: z.literal('retry_finish') }),
  z.object({ verdict: z.literal('record_manual_report'), ncmecReportId: ncmecReportIdSchema }),
]);

type Verdict = z.infer<typeof bodySchema>['verdict'];

// Targets the flagged user so an admin's moderation history against an account is filterable.
const recordVerdict = (
  req: Request,
  incident: { incidentId: string; userId: string },
  verdict: Verdict,
  details: Record<string, unknown> = {}
) =>
  recordAdminActionFromRequest(req, {
    action: 'moderation.incident.verdict_recorded',
    target: { kind: 'user', id: incident.userId, displayName: incident.userId },
    summary: `recorded ${verdict} verdict on moderation incident ${incident.incidentId}`,
    details: { incidentId: incident.incidentId, verdict, ...details },
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

  const body = parsed.data;

  // Recovery paths: move a stuck confirmed_csam incident without claiming it.
  if (body.verdict === 'mark_reported') {
    const adminId = req.user.id;
    const updated = await withTransaction(async () => {
      const resolved = await imageModerationIncidentRepository.resolveConfirmedCsam(incidentId, {
        status: 'reported',
        ncmecReportId: body.ncmecReportId,
        reportedBy: adminId,
      });
      if (resolved) {
        await recordVerdict(req, { incidentId, userId: resolved.userId }, body.verdict, {
          ncmecReportId: body.ncmecReportId,
        });
      }
      return resolved;
    });
    if (!updated) {
      return res
        .status(409)
        .json({ error: 'Incident is not a stale confirmed_csam claim (wrong state, or submission still in flight)' });
    }
    req.logger.info(
      `[NCMEC] incident ${incidentId} manually marked reported, reportId=${body.ncmecReportId}, by admin=${req.user.id}`
    );
    return res.status(200).json({ ok: true, ncmecReportId: body.ncmecReportId });
  }

  if (body.verdict === 'requeue') {
    const updated = await withTransaction(async () => {
      const resolved = await imageModerationIncidentRepository.resolveConfirmedCsam(incidentId, {
        status: 'pending_review',
      });
      if (resolved) await recordVerdict(req, { incidentId, userId: resolved.userId }, body.verdict);
      return resolved;
    });
    if (!updated) {
      return res.status(409).json({
        error:
          'Incident is not a stale confirmed_csam claim without an ncmecReportId (wrong state, submission still in flight, or an unfinished report exists -- use retry_finish within the 24-hour window, or mark_reported once it is finalized)',
      });
    }
    req.logger.info(`[Moderation] incident ${incidentId} requeued from confirmed_csam by admin=${req.user.id}`);
    return res.status(200).json({ ok: true });
  }

  if (body.verdict === 'retry_finish') {
    // Re-call /finish for an incident that is stuck in confirmed_csam with a stored reportId.
    // The report was accepted by NCMEC (a prior /submit succeeded) but /finish failed.
    // NCMEC holds unfinished reports for 24 hours; retrying /finish is safe and idempotent.
    const incident = await imageModerationIncidentRepository.findById(incidentId);
    if (!incident || incident.reviewStatus !== 'confirmed_csam') {
      return res.status(409).json({ error: 'Incident is not in confirmed_csam state' });
    }
    if (!incident.ncmecReportId) {
      return res.status(409).json({
        error:
          'Incident has no stored reportId -- check the [NCMEC] log lines for a reportId before requeueing; if one is there use mark_reported, if NCMEC confirmed no tip was filed use requeue',
      });
    }
    const credentials = resolveNcmecCredentials();
    if (!isNcmecConfigured(credentials)) {
      return res.status(503).json({
        error:
          'NCMEC credentials not configured -- set NCMEC_ESP_ID, NCMEC_API_KEY and NCMEC_ESP_EMAIL via sst secret set',
      });
    }
    try {
      await ncmecService.finishNcmecReport(credentials, incident.ncmecReportId);
    } catch (err) {
      req.logger.error(
        `[NCMEC] retry_finish failed for incident ${incidentId}, reportId=${incident.ncmecReportId}, by admin=${req.user.id}: ${(err as Error).message}`
      );
      return res.status(502).json({ error: `NCMEC /finish retry failed: ${(err as Error).message}` });
    }
    req.logger.info(
      `[NCMEC] retry_finish succeeded for incident ${incidentId}, reportId=${incident.ncmecReportId}, by admin=${req.user.id}; marking reported`
    );
    // Pass staleAfterMs=0: /finish just succeeded so the outcome is known; the stale filter
    // is not appropriate here (it exists to prevent mark_reported/requeue from racing a live
    // in-flight submission, not to gate a retry we just confirmed succeeded).
    // /finish already succeeded, so the verdict is audited even when a concurrent resolution
    // won the DB write; a failed audit leaves the incident retryable (/finish is idempotent).
    const ncmecReportId = incident.ncmecReportId;
    const adminId = req.user.id;
    const updated = await withTransaction(async () => {
      const resolved = await imageModerationIncidentRepository.resolveConfirmedCsam(
        incidentId,
        { status: 'reported', ncmecReportId, reportedBy: adminId },
        0
      );
      await recordVerdict(req, { incidentId, userId: incident.userId }, body.verdict, {
        ncmecReportId,
        incidentUpdated: resolved !== null,
      });
      return resolved;
    });
    if (!updated) {
      // Concurrent mark_reported or requeue resolved the incident between our /finish call
      // and this DB write. The reportId is in the log above; the incident is already closed.
      req.logger.warn(
        `[NCMEC] retry_finish: /finish succeeded but DB update found no matching document (concurrent resolution?) for incident ${incidentId}`
      );
    }
    return res.status(200).json({ ok: true, ncmecReportId: incident.ncmecReportId });
  }

  if (body.verdict === 'record_manual_report') {
    const adminId = req.user.id;
    const updated = await withTransaction(async () => {
      const recorded = await imageModerationIncidentRepository.recordManualReport(incidentId, {
        ncmecReportId: body.ncmecReportId,
        reportedBy: adminId,
      });
      if (recorded) {
        await recordVerdict(req, { incidentId, userId: recorded.userId }, body.verdict, {
          ncmecReportId: body.ncmecReportId,
          previousReviewStatus: recorded.previousReviewStatus ?? null,
        });
      }
      return recorded;
    });
    if (!updated) {
      const incident = await imageModerationIncidentRepository.findById(incidentId);
      // The admin already filed this tip with NCMEC; log its id so a refusal never loses it.
      req.logger.warn(
        `[NCMEC] record_manual_report refused for incident ${incidentId} (state=${incident?.reviewStatus ?? 'missing'}); admin-supplied reportId=${body.ncmecReportId}, by admin=${req.user.id}`
      );
      if (!incident) return res.status(404).json({ error: 'Incident not found' });
      if (incident.reviewStatus === 'confirmed_csam') {
        return res.status(409).json({
          error: incident.ncmecReportId
            ? `Incident has an unfinished API report (reportId=${incident.ncmecReportId}) -- use retry_finish within NCMEC's 24-hour window; after it, file by hand on the web form and use mark_reported with the new report id`
            : 'Incident has an API submission in flight or with an unknown outcome -- once it is stale, use mark_reported if NCMEC has a tip, or requeue then record_manual_report if it does not',
        });
      }
      if (incident.reviewStatus === 'reported') {
        // A second filed tip is not stored on the incident; the warn line above is its only record.
        return res.status(409).json({
          error: `Incident is already reported (reportId=${incident.ncmecReportId ?? 'unknown'}); your report id was not stored -- keep it for the duplicate-tip record`,
        });
      }
      return res.status(409).json({ error: `Incident is already ${incident.reviewStatus}` });
    }
    req.logger.info(
      `[NCMEC] incident ${incidentId} recorded as manually reported${updated.previousReviewStatus ? ` (overriding ${updated.previousReviewStatus})` : ''}, reportId=${body.ncmecReportId}, by admin=${req.user.id}`
    );
    return res.status(200).json({ ok: true, ncmecReportId: body.ncmecReportId });
  }

  if (body.verdict === 'confirmed_csam') {
    // Validate credentials before claiming the incident. If credentials are not configured
    // the service call would fail, and a plain-Error throw would strand the incident in
    // confirmed_csam with no API exit. Return 503 before the claim so the incident is
    // never moved out of pending_review in the first place.
    const credentials = resolveNcmecCredentials();
    if (!isNcmecConfigured(credentials)) {
      return res.status(503).json({
        error:
          'NCMEC credentials not configured -- set NCMEC_ESP_ID, NCMEC_API_KEY and NCMEC_ESP_EMAIL via sst secret set',
      });
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
      if (incident.reviewStatus === 'reported')
        return res.status(409).json({ error: 'Incident already reported to NCMEC' });
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
        req.logger.info(
          `[NCMEC] /finish failed for incident ${incidentId}; persisting reportId=${finishErr.reportId} for manual recovery`
        );
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
    req.logger.info(
      `[NCMEC] submission accepted for incident ${incidentId}, reportId=${ncmecReportId}; persisting to DB`
    );

    // A failed audit rolls this write back and the request 500s with the incident left in
    // confirmed_csam; the reportId logged above lets an admin finish it with mark_reported.
    const adminId = req.user.id;
    const updated = await withTransaction(async () => {
      const reported = await imageModerationIncidentRepository.updateReviewStatus(
        incidentId,
        'reported',
        ncmecReportId,
        adminId
      );
      if (reported) {
        await recordVerdict(req, { incidentId, userId: claimed.userId }, body.verdict, { ncmecReportId });
      }
      return reported;
    });
    if (!updated) {
      req.logger.warn(
        `[NCMEC] DB update skipped for incident ${incidentId} (already reported); NCMEC reportId=${ncmecReportId}`
      );
      return res.status(409).json({ error: 'Incident already reported to NCMEC (concurrent request)' });
    }

    req.logger.info(
      `[NCMEC] incident ${incidentId} marked reported, reportId=${ncmecReportId}, by admin=${req.user.id}`
    );
    return res.status(200).json({ ok: true, ncmecReportId });
  }

  // false_positive: no NCMEC submission, just update the status.
  const adminId = req.user.id;
  const updated = await withTransaction(async () => {
    const reviewed = await imageModerationIncidentRepository.updateReviewStatus(
      incidentId,
      'false_positive',
      undefined,
      adminId
    );
    if (reviewed) await recordVerdict(req, { incidentId, userId: reviewed.userId }, body.verdict);
    return reviewed;
  });
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
