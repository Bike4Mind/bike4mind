// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks (must come before the handler import) ----

const mockClaimForNcmecSubmission = vi.fn();
const mockFindById = vi.fn();
const mockUpdateReviewStatus = vi.fn();
const mockSubmitNcmecReport = vi.fn();

vi.mock('@bike4mind/database', () => ({
  imageModerationIncidentRepository: {
    claimForNcmecSubmission: (...args: unknown[]) => mockClaimForNcmecSubmission(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
    updateReviewStatus: (...args: unknown[]) => mockUpdateReviewStatus(...args),
  },
}));

vi.mock('@bike4mind/services', () => {
  class NcmecRejectedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NcmecRejectedError';
    }
  }
  return {
    ncmecService: {
      submitNcmecReport: (...args: unknown[]) => mockSubmitNcmecReport(...args),
      NcmecRejectedError,
    },
  };
});

// SST Resource -- no secrets configured in tests; credentials are resolved by resolveNcmecCredentials
// and passed into submitNcmecReport. The service mock does not use them.
vi.mock('sst', () => ({ Resource: {} }));

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

// ncmecService.NcmecRejectedError is the mocked class -- use it to construct typed errors.
const NcmecRejectedError = ncmecService.NcmecRejectedError as unknown as new (msg: string) => Error;

// ---- Tests ----

describe('admin/moderation-incidents/[id]/verdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------ confirmed_csam -- success
  describe('verdict: confirmed_csam', () => {
    it('outcome 1 — success: submits to NCMEC and marks incident reported', async () => {
      mockClaimForNcmecSubmission.mockResolvedValue(CLAIMED_INCIDENT);
      mockSubmitNcmecReport.mockResolvedValue({ reportId: 'RPT-001' });
      mockUpdateReviewStatus.mockResolvedValue({ ...CLAIMED_INCIDENT, reviewStatus: 'reported', ncmecReportId: 'RPT-001' });

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
    it('outcome 2 — rejected (NcmecRejectedError): rolls back to pending_review and returns 502', async () => {
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
    it('outcome 3 — unknown outcome (plain Error): does NOT roll back; leaves in confirmed_csam', async () => {
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
