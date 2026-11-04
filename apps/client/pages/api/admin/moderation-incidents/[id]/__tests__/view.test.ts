// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  findById: vi.fn(),
  record: vi.fn(),
  requireStepUp: vi.fn(),
  sign: vi.fn(),
  order: [] as string[],
  adminApiOptions: undefined as unknown,
}));

vi.mock('@bike4mind/database', () => ({ imageModerationIncidentRepository: { findById: m.findById } }));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    m.adminApiOptions = options;
    return { get: (h: (...args: unknown[]) => unknown) => h };
  },
}));
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: m.requireStepUp }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: m.record }));
vi.mock('@server/moderation/incidentImageLink', () => ({ signIncidentImage: m.sign }));

import handler from '../view';

const runHandler = handler as unknown as (req: unknown, res: unknown) => Promise<void>;

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const makeRes = () => {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn();
  return res;
};
const makeReq = (over: Record<string, unknown> = {}) => ({
  user: { id: 'admin-1', isAdmin: true },
  query: { id: ID },
  ...over,
});
const INCIDENT = {
  id: ID,
  userId: 'user-1',
  createdAt: new Date('2026-10-30T10:00:00Z'),
  surface: 'upload',
  reviewStatus: undefined,
  fabFileId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  sessionId: 'session-9',
  questId: 'quest-9',
  provider: 'bfl',
  model: 'flux-pro-1.1',
  labels: [{ name: 'Explicit', parentName: '', confidence: 97.31, _id: 'drop-me' }],
  alertedAt: new Date('2026-10-30T10:01:00Z'),
  reportedBy: 'admin-7',
  falsePositiveBy: 'admin-8',
};
const READY = { availability: 'ready', url: 'https://signed.example/img', expiresAt: '2026-10-30T10:05:00.000Z' };

describe('admin/moderation-incidents/[id]/view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.order = [];
    m.findById.mockResolvedValue(INCIDENT);
    m.requireStepUp.mockResolvedValue(undefined);
    m.record.mockImplementation(async () => void m.order.push('audit'));
    m.sign.mockImplementation(async () => {
      m.order.push('sign');
      return READY;
    });
  });

  it('records the view before signing the image and returns metadata only, uncached', async () => {
    const res = makeRes();
    await runHandler(makeReq(), res);

    expect(m.order).toEqual(['audit', 'sign']);
    expect(m.record).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.anything() }),
      expect.objectContaining({
        action: 'moderation.incident.viewed',
        target: expect.objectContaining({ id: ID }),
        details: { incidentId: ID },
      })
    );
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      id: ID,
      createdAt: INCIDENT.createdAt,
      surface: 'upload',
      reviewStatus: 'pending_review',
      provider: 'bfl',
      model: 'flux-pro-1.1',
      labels: [{ name: 'Explicit', parentName: '', confidence: 97.31 }],
      alertedAt: INCIDENT.alertedAt,
      lastReminderAt: null,
      reportedAt: null,
      ncmecReportId: null,
      reportChannel: null,
      falsePositiveAt: null,
      previousReviewStatus: null,
      image: READY,
    });
  });

  it('never returns a user, session, quest, file or reviewer reference', async () => {
    const res = makeRes();
    await runHandler(makeReq(), res);
    const body = JSON.stringify((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(body).not.toMatch(/user-1|session-9|quest-9|fabFile|bbbb|admin-7|admin-8|drop-me/);
  });

  it('returns the prior verdict and report details once one is recorded', async () => {
    const reportedAt = new Date('2026-10-31T09:00:00Z');
    const falsePositiveAt = new Date('2026-10-30T12:00:00Z');
    m.findById.mockResolvedValue({
      ...INCIDENT,
      reviewStatus: 'reported',
      ncmecReportId: 'RPT-1',
      reportChannel: 'manual',
      reportedAt,
      falsePositiveAt,
      previousReviewStatus: 'false_positive',
    });
    const res = makeRes();
    await runHandler(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewStatus: 'reported',
        ncmecReportId: 'RPT-1',
        reportChannel: 'manual',
        reportedAt,
        falsePositiveAt,
        previousReviewStatus: 'false_positive',
      })
    );
  });

  it('accepts JWT sessions only, never an API key', () => {
    expect(m.adminApiOptions).toMatchObject({ auth: 'jwtOnly' });
  });

  it('refuses a delegated admin before any lookup, audit or signing', async () => {
    await expect(
      runHandler(makeReq({ user: { id: 'delegate', isAdmin: false, adminPermissions: ['users:moderate'] } }), makeRes())
    ).rejects.toThrow('Admin access required');
    expect(m.findById).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
    expect(m.sign).not.toHaveBeenCalled();
  });

  it('propagates a missing step-up without auditing or signing', async () => {
    m.requireStepUp.mockRejectedValue(new Error('Recent verification required'));
    await expect(runHandler(makeReq(), makeRes())).rejects.toThrow('Recent verification required');
    expect(m.record).not.toHaveBeenCalled();
    expect(m.sign).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown or malformed id without auditing', async () => {
    m.findById.mockResolvedValue(null);
    await expect(runHandler(makeReq(), makeRes())).rejects.toThrow('Incident not found');
    await expect(runHandler(makeReq({ query: { id: 'not-an-id' } }), makeRes())).rejects.toThrow('Incident not found');
    expect(m.record).not.toHaveBeenCalled();
  });

  it('yields no image when the view cannot be recorded', async () => {
    m.record.mockRejectedValue(new Error('audit write failed'));
    const res = makeRes();
    await expect(runHandler(makeReq(), res)).rejects.toThrow('audit write failed');
    expect(m.sign).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('keeps a recorded status', async () => {
    m.findById.mockResolvedValue({ ...INCIDENT, reviewStatus: 'false_positive' });
    const res = makeRes();
    await runHandler(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reviewStatus: 'false_positive' }));
  });
});
