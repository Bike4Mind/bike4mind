// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks (must come before the handler import) ----

const mockClaimForNcmecSubmission = vi.fn();
const mockFindById = vi.fn();
const mockUpdateReviewStatus = vi.fn();
const mockResolveConfirmedCsam = vi.fn();
const mockSetNcmecReportId = vi.fn();
const mockRecordManualReport = vi.fn();
const mockSubmitNcmecReport = vi.fn();
const mockFinishNcmecReport = vi.fn();

vi.mock('@bike4mind/database', () => ({
  imageModerationIncidentRepository: {
    claimForNcmecSubmission: (...args: unknown[]) => mockClaimForNcmecSubmission(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
    updateReviewStatus: (...args: unknown[]) => mockUpdateReviewStatus(...args),
    resolveConfirmedCsam: (...args: unknown[]) => mockResolveConfirmedCsam(...args),
    setNcmecReportId: (...args: unknown[]) => mockSetNcmecReportId(...args),
    recordManualReport: (...args: unknown[]) => mockRecordManualReport(...args),
  },
}));

vi.mock('@bike4mind/services', () => {
  class NcmecRejectedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NcmecRejectedError';
    }
  }
  class NcmecFinishFailedError extends Error {
    readonly reportId: string;
    constructor(message: string, reportId: string) {
      super(message);
      this.name = 'NcmecFinishFailedError';
      this.reportId = reportId;
    }
  }
  return {
    ncmecService: {
      submitNcmecReport: (...args: unknown[]) => mockSubmitNcmecReport(...args),
      finishNcmecReport: (...args: unknown[]) => mockFinishNcmecReport(...args),
      NcmecRejectedError,
      NcmecFinishFailedError,
    },
  };
});

// SST Resource -- credentials are configured so the pre-claim check passes in most tests.
// Tests that want to exercise the 503 path override this mock locally.
vi.mock('sst', () => ({
  Resource: {
    NCMEC_ESP_ID: { value: 'esp-test-id' },
    NCMEC_API_KEY: { value: 'test-api-key' },
    NCMEC_ESP_EMAIL: { value: 'esp@example.com' },
    NCMEC_USE_SANDBOX: { value: 'true' },
  },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (h: (...args: unknown[]) => unknown) => h,
  }),
}));

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

// ---- Import handler after mocks ----

import handler from '../verdict';
import { ncmecService } from '@bike4mind/services';

const runHandler = handler as unknown as (req: unknown, res: unknown) => Promise<void>;

// ---- Helpers ----

const makeRes = () => {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

const makeReq = (body: Record<string, unknown>, id = 'inc-1') => ({
  user: { isAdmin: true, id: 'admin-1' },
  query: { id },
  body,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

const CLAIMED_INCIDENT = {
  _id: 'inc-1',
  userId: 'user-suspect-1',
  createdAt: new Date('2026-01-15T10:00:00Z'),
  labels: [{ name: 'Explicit Nudity', confidence: 98.0 }],
  fabFileId: 'file-1',
  reviewStatus: 'confirmed_csam',
};

// ncmecService error classes from the mock -- use them to construct typed errors in tests.
const NcmecRejectedError = ncmecService.NcmecRejectedError as unknown as new (msg: string) => Error;
const NcmecFinishFailedError = ncmecService.NcmecFinishFailedError as unknown as new (
  msg: string,
  reportId: string
) => Error & { reportId: string };

// ---- Tests ----

describe('admin/moderation-incidents/[id]/verdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------ confirmed_csam -- success
  describe('verdict: confirmed_csam', () => {
    it('outcome 1 - success: submits to NCMEC and marks incident reported', async () => {
      mockClaimForNcmecSubmission.mockResolvedValue(CLAIMED_INCIDENT);
      mockSubmitNcmecReport.mockResolvedValue({ reportId: 'RPT-001' });
      mockUpdateReviewStatus.mockResolvedValue({
        ...CLAIMED_INCIDENT,
        reviewStatus: 'reported',
        ncmecReportId: 'RPT-001',
      });

      const req = makeReq({ verdict: 'confirmed_csam' });
      const res = makeRes();
      await runHandler(req, res);

      expect(mockClaimForNcmecSubmission).toHaveBeenCalledWith('inc-1');
      expect(mockSubmitNcmecReport).toHaveBeenCalledOnce();
      expect(mockUpdateReviewStatus).toHaveBeenCalledWith('inc-1', 'reported', 'RPT-001');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true, ncmecReportId: 'RPT-001' });
    });

    // ---------------------------------------------------------------- confirmed_csam -- rejected
    it('outcome 2 - rejected (NcmecRejectedError): rolls back to pending_review and returns 502', async () => {
      mockClaimForNcmecSubmission.mockResolvedValue(CLAIMED_INCIDENT);
      mockSubmitNcmecReport.mockRejectedValue(new NcmecRejectedError('NCMEC /submit error 401: Unauthorized'));
      mockUpdateReviewStatus.mockResolvedValue({ ...CLAIMED_INCIDENT, reviewStatus: 'pending_review' });

      const req = makeReq({ verdict: 'confirmed_csam' });
      const res = makeRes();
      await runHandler(req, res);

      // Rollback must happen on a definitive rejection.
      expect(mockUpdateReviewStatus).toHaveBeenCalledWith('inc-1', 'pending_review');
      // No 'reported' write.
      expect(mockUpdateReviewStatus).not.toHaveBeenCalledWith('inc-1', 'reported', expect.anything());
      expect(res.status).toHaveBeenCalledWith(502);
      const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { error: string };
      expect(body.error).toContain('NCMEC rejected');
    });

    // ---------------------------------------------------------------- confirmed_csam -- unknown
    it('outcome 3 - unknown outcome (plain Error): does NOT roll back; leaves in confirmed_csam', async () => {
      mockClaimForNcmecSubmission.mockResolvedValue(CLAIMED_INCIDENT);
      mockSubmitNcmecReport.mockRejectedValue(new Error('NCMEC /submit response missing reportId: <response/>'));

      const req = makeReq({ verdict: 'confirmed_csam' });
      const res = makeRes();
      await runHandler(req, res);

      // No rollback call at all -- unknown outcome must not roll back.
      expect(mockUpdateReviewStatus).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(502);
      const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { error: string };
      expect(body.error).toContain('confirmed_csam');
      expect(body.error).toContain('verify with NCMEC');
    });

    it('returns 404 when the incident does not exist', async () => {
      mockClaimForNcmecSubmission.mockResolvedValue(null);
      mockFindById.mockResolvedValue(null);

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'confirmed_csam' }), res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 409 when the incident is already reported', async () => {
      mockClaimForNcmecSubmission.mockResolvedValue(null);
      mockFindById.mockResolvedValue({ reviewStatus: 'reported' });

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'confirmed_csam' }), res);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { error: string };
      expect(body.error).toContain('already reported');
    });

    it('returns 409 when the incident is already claimed (in-flight concurrent verdict)', async () => {
      mockClaimForNcmecSubmission.mockResolvedValue(null);
      mockFindById.mockResolvedValue({ reviewStatus: 'confirmed_csam' });

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'confirmed_csam' }), res);

      expect(res.status).toHaveBeenCalledWith(409);
    });

    // ---------------------------------------------------------------- confirmed_csam -- /finish failed
    it('outcome 4 - NcmecFinishFailedError: persists reportId and returns 502 without rollback', async () => {
      mockClaimForNcmecSubmission.mockResolvedValue(CLAIMED_INCIDENT);
      mockSubmitNcmecReport.mockRejectedValue(new NcmecFinishFailedError('NCMEC /finish error 500', 'RPT-FINISH-FAIL'));
      mockSetNcmecReportId.mockResolvedValue(undefined);

      const req = makeReq({ verdict: 'confirmed_csam' });
      const res = makeRes();
      await runHandler(req, res);

      // reportId persisted for manual recovery.
      expect(mockSetNcmecReportId).toHaveBeenCalledWith('inc-1', 'RPT-FINISH-FAIL');
      // No rollback on /finish failure.
      expect(mockUpdateReviewStatus).not.toHaveBeenCalledWith('inc-1', 'pending_review');
      expect(res.status).toHaveBeenCalledWith(502);
      const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { error: string };
      expect(body.error).toContain('confirmed_csam');
    });

    // ---------------------------------------------------------------- confirmed_csam -- pre-flight: credentials
    it('returns 503 when NCMEC credentials are not configured; incident is never claimed', async () => {
      // Mutate the shared mock object so resolveNcmecCredentials sees 'not-configured'.
      const { Resource } = await import('sst');
      const r = Resource as unknown as Record<string, { value: string }>;
      const savedEspId = r.NCMEC_ESP_ID?.value;
      r.NCMEC_ESP_ID = { value: 'not-configured' };
      try {
        const res = makeRes();
        await runHandler(makeReq({ verdict: 'confirmed_csam' }), res);
        // Incident must never be claimed -- pre-claim guard fires first.
        expect(mockClaimForNcmecSubmission).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(503);
      } finally {
        r.NCMEC_ESP_ID = { value: savedEspId };
      }
    });

    it('logs the reportId before the DB write so it is recoverable if the write fails', async () => {
      mockClaimForNcmecSubmission.mockResolvedValue(CLAIMED_INCIDENT);
      mockSubmitNcmecReport.mockResolvedValue({ reportId: 'RPT-LOG-TEST' });
      mockUpdateReviewStatus.mockResolvedValue(null); // simulate concurrent win

      const req = makeReq({ verdict: 'confirmed_csam' });
      const res = makeRes();
      await runHandler(req, res);

      const loggedInfo = (req as { logger: { info: ReturnType<typeof vi.fn> } }).logger.info;
      const logCalls = loggedInfo.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(logCalls.some(msg => msg.includes('RPT-LOG-TEST'))).toBe(true);
    });
  });

  // ------------------------------------------------------------------ false_positive
  describe('verdict: false_positive', () => {
    it('marks the incident false_positive without calling NCMEC', async () => {
      mockUpdateReviewStatus.mockResolvedValue({ reviewStatus: 'false_positive' });

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'false_positive' }), res);

      expect(mockSubmitNcmecReport).not.toHaveBeenCalled();
      expect(mockClaimForNcmecSubmission).not.toHaveBeenCalled();
      expect(mockUpdateReviewStatus).toHaveBeenCalledWith('inc-1', 'false_positive');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 404 when the incident is not found', async () => {
      mockUpdateReviewStatus.mockResolvedValue(null);
      mockFindById.mockResolvedValue(null);

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'false_positive' }), res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 409 when the incident is already reported or being processed', async () => {
      mockUpdateReviewStatus.mockResolvedValue(null);
      mockFindById.mockResolvedValue({ reviewStatus: 'confirmed_csam' });

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'false_positive' }), res);

      expect(res.status).toHaveBeenCalledWith(409);
    });
  });

  // ------------------------------------------------------------------ mark_reported (recovery)
  describe('verdict: mark_reported', () => {
    it('moves confirmed_csam to reported with the supplied ncmecReportId', async () => {
      mockResolveConfirmedCsam.mockResolvedValue({
        ...CLAIMED_INCIDENT,
        reviewStatus: 'reported',
        ncmecReportId: 'RPT-MANUAL',
      });

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'mark_reported', ncmecReportId: 'RPT-MANUAL' }), res);

      expect(mockResolveConfirmedCsam).toHaveBeenCalledWith('inc-1', {
        status: 'reported',
        ncmecReportId: 'RPT-MANUAL',
      });
      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { ok: boolean; ncmecReportId: string };
      expect(body.ncmecReportId).toBe('RPT-MANUAL');
    });

    it('returns 409 when the incident is not in confirmed_csam', async () => {
      mockResolveConfirmedCsam.mockResolvedValue(null);

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'mark_reported', ncmecReportId: 'RPT-MANUAL' }), res);

      expect(res.status).toHaveBeenCalledWith(409);
    });
  });

  // ------------------------------------------------------------------ requeue (recovery)
  describe('verdict: requeue', () => {
    it('moves confirmed_csam back to pending_review', async () => {
      mockResolveConfirmedCsam.mockResolvedValue({ ...CLAIMED_INCIDENT, reviewStatus: 'pending_review' });

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'requeue' }), res);

      expect(mockResolveConfirmedCsam).toHaveBeenCalledWith('inc-1', { status: 'pending_review' });
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 409 when the incident is not in confirmed_csam', async () => {
      mockResolveConfirmedCsam.mockResolvedValue(null);

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'requeue' }), res);

      expect(res.status).toHaveBeenCalledWith(409);
    });
  });

  // ------------------------------------------------------------------ retry_finish (recovery)
  describe('verdict: retry_finish', () => {
    it('calls /finish with the stored reportId and marks the incident reported', async () => {
      const incident = { ...CLAIMED_INCIDENT, reviewStatus: 'confirmed_csam', ncmecReportId: 'RPT-STORED' };
      mockFindById.mockResolvedValue(incident);
      mockFinishNcmecReport.mockResolvedValue(undefined);
      mockResolveConfirmedCsam.mockResolvedValue({ ...incident, reviewStatus: 'reported' });

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'retry_finish' }), res);

      expect(mockFinishNcmecReport).toHaveBeenCalledOnce();
      // staleAfterMs=0 bypasses the stale guard -- outcome is known after /finish succeeds
      expect(mockResolveConfirmedCsam).toHaveBeenCalledWith(
        'inc-1',
        { status: 'reported', ncmecReportId: 'RPT-STORED' },
        0
      );
      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { ok: boolean; ncmecReportId: string };
      expect(body.ncmecReportId).toBe('RPT-STORED');
    });

    it('returns 409 when the incident is not in confirmed_csam', async () => {
      mockFindById.mockResolvedValue({ ...CLAIMED_INCIDENT, reviewStatus: 'reported' });

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'retry_finish' }), res);

      expect(mockFinishNcmecReport).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('returns 409 when the incident has no stored reportId', async () => {
      mockFindById.mockResolvedValue({ ...CLAIMED_INCIDENT, reviewStatus: 'confirmed_csam' }); // no ncmecReportId

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'retry_finish' }), res);

      expect(mockFinishNcmecReport).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('returns 502 when /finish fails', async () => {
      mockFindById.mockResolvedValue({
        ...CLAIMED_INCIDENT,
        reviewStatus: 'confirmed_csam',
        ncmecReportId: 'RPT-STORED',
      });
      mockFinishNcmecReport.mockRejectedValue(new Error('NCMEC /finish error 500: Internal Error'));

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'retry_finish' }), res);

      expect(mockResolveConfirmedCsam).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(502);
    });

    it('returns 200 with reportId even when resolveConfirmedCsam returns null (concurrent resolution)', async () => {
      const incident = { ...CLAIMED_INCIDENT, reviewStatus: 'confirmed_csam', ncmecReportId: 'RPT-STORED' };
      mockFindById.mockResolvedValue(incident);
      mockFinishNcmecReport.mockResolvedValue(undefined);
      mockResolveConfirmedCsam.mockResolvedValue(null); // concurrent mark_reported already closed it

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'retry_finish' }), res);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { ok: boolean; ncmecReportId: string };
      expect(body.ncmecReportId).toBe('RPT-STORED');
    });
  });

  // ------------------------------------------------------------------ record_manual_report
  describe('verdict: record_manual_report', () => {
    it('records a web-form filing as reported, attributed to the admin, without calling NCMEC', async () => {
      mockRecordManualReport.mockResolvedValue({ reviewStatus: 'reported', ncmecReportId: '123456' });

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'record_manual_report', ncmecReportId: ' 123456 ' }), res);

      expect(mockRecordManualReport).toHaveBeenCalledWith('inc-1', { ncmecReportId: '123456', reportedBy: 'admin-1' });
      expect(mockSubmitNcmecReport).not.toHaveBeenCalled();
      expect(mockClaimForNcmecSubmission).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ok: true, ncmecReportId: '123456' });
    });

    it('works when NCMEC API credentials are not configured', async () => {
      const { Resource } = await import('sst');
      const r = Resource as unknown as Record<string, { value: string }>;
      const savedEspId = r.NCMEC_ESP_ID?.value;
      r.NCMEC_ESP_ID = { value: 'not-configured' };
      try {
        mockRecordManualReport.mockResolvedValue({ reviewStatus: 'reported', ncmecReportId: '123456' });
        const res = makeRes();
        await runHandler(makeReq({ verdict: 'record_manual_report', ncmecReportId: '123456' }), res);
        expect(res.status).toHaveBeenCalledWith(200);
      } finally {
        r.NCMEC_ESP_ID = { value: savedEspId };
      }
    });

    it('returns 404 when the incident does not exist', async () => {
      mockRecordManualReport.mockResolvedValue(null);
      mockFindById.mockResolvedValue(null);

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'record_manual_report', ncmecReportId: '123456' }), res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 409 pointing at mark_reported or requeue when an API submission holds the claim', async () => {
      mockRecordManualReport.mockResolvedValue(null);
      mockFindById.mockResolvedValue({ reviewStatus: 'confirmed_csam' });

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'record_manual_report', ncmecReportId: '123456' }), res);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { error: string };
      expect(body.error).toContain('mark_reported');
      expect(body.error).toContain('requeue');
    });

    it('returns 409 pointing at retry_finish when the API claim holds an unfinished reportId', async () => {
      mockRecordManualReport.mockResolvedValue(null);
      mockFindById.mockResolvedValue({ reviewStatus: 'confirmed_csam', ncmecReportId: 'RPT-STORED' });

      const res = makeRes();
      await runHandler(makeReq({ verdict: 'record_manual_report', ncmecReportId: '123456' }), res);

      expect(res.status).toHaveBeenCalledWith(409);
      const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { error: string };
      expect(body.error).toContain('retry_finish');
      expect(body.error).not.toContain('mark_reported');
    });

    it('logs the admin-supplied reportId when the verdict is refused', async () => {
      for (const incident of [null, { reviewStatus: 'false_positive' }]) {
        mockRecordManualReport.mockResolvedValue(null);
        mockFindById.mockResolvedValue(incident);

        const req = makeReq({ verdict: 'record_manual_report', ncmecReportId: '123456' });
        await runHandler(req, makeRes());

        expect(req.logger.warn).toHaveBeenCalledWith(expect.stringContaining('reportId=123456'));
      }
    });

    it('returns 409 when the incident is already reported or false_positive', async () => {
      for (const reviewStatus of ['reported', 'false_positive']) {
        mockRecordManualReport.mockResolvedValue(null);
        mockFindById.mockResolvedValue({ reviewStatus });

        const res = makeRes();
        await runHandler(makeReq({ verdict: 'record_manual_report', ncmecReportId: '123456' }), res);

        expect(res.status).toHaveBeenCalledWith(409);
      }
    });

    it('returns 400 when ncmecReportId is missing, blank, too long, or has disallowed characters', async () => {
      for (const ncmecReportId of [undefined, '   ', 'x'.repeat(65), '123\n456', '123 456', '12/34']) {
        const res = makeRes();
        await runHandler(makeReq({ verdict: 'record_manual_report', ncmecReportId }), res);
        expect(res.status).toHaveBeenCalledWith(400);
      }
      expect(mockRecordManualReport).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ validation
  describe('request validation', () => {
    it('returns 400 for an invalid verdict value', async () => {
      const res = makeRes();
      await runHandler(makeReq({ verdict: 'invalid_verdict' }), res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for a missing body', async () => {
      const res = makeRes();
      await runHandler(makeReq({}), res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});
