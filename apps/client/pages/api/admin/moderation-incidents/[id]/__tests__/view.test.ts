// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  findById: vi.fn(),
  findUserById: vi.fn(),
  record: vi.fn(),
  requireStepUp: vi.fn(),
  sign: vi.fn(),
  order: [] as string[],
  adminApiOptions: undefined as unknown,
}));

vi.mock('@bike4mind/database', () => ({
  imageModerationIncidentRepository: { findById: m.findById },
  userRepository: { findById: m.findUserById },
}));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    m.adminApiOptions = options;
    return { get: (h: (...args: unknown[]) => unknown) => h };
  },
}));
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: m.requireStepUp }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: m.record }));
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
const USER_ID = 'cccccccccccccccccccccccc';
const INCIDENT = {
  id: ID,
  userId: USER_ID,
  createdAt: new Date('2026-10-30T10:00:00Z'),
  surface: 'generation',
  reviewStatus: undefined,
  provider: 'example-provider',
  model: 'example-model',
  sessionId: 'dddddddddddddddddddddddd',
  questId: 'eeeeeeeeeeeeeeeeeeeeeeee',
  labels: [{ name: 'Explicit Nudity', parentName: 'Explicit', confidence: 97.5 }],
  alertedAt: new Date('2026-10-30T10:01:00Z'),
};
const READY = { availability: 'ready', url: 'https://signed.example/img', expiresAt: '2026-10-30T10:05:00.000Z' };

describe('admin/moderation-incidents/[id]/view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.order = [];
    m.findById.mockResolvedValue(INCIDENT);
    m.findUserById.mockImplementation(async () => {
      m.order.push('user');
      return { id: USER_ID, email: 'flagged@example.com' };
    });
    m.requireStepUp.mockResolvedValue(undefined);
    m.record.mockImplementation(async () => void m.order.push('audit'));
    m.sign.mockImplementation(async () => {
      m.order.push('sign');
      return READY;
    });
  });

  it('records the view before signing the image or reading the user, and returns the review context uncached', async () => {
    const res = makeRes();
    await runHandler(makeReq(), res);

    expect(m.order[0]).toBe('audit');
    expect([...m.order].sort()).toEqual(['audit', 'sign', 'user']);
    expect(m.findUserById).toHaveBeenCalledWith(USER_ID);
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
      surface: 'generation',
      reviewStatus: 'pending_review',
      previousReviewStatus: null,
      user: { id: USER_ID, email: 'flagged@example.com' },
      labels: [{ name: 'Explicit Nudity', parentName: 'Explicit', confidence: 97.5 }],
      provider: 'example-provider',
      model: 'example-model',
      sessionId: INCIDENT.sessionId,
      questId: INCIDENT.questId,
      fabFileId: null,
      ncmecReportId: null,
      alertedAt: INCIDENT.alertedAt,
      lastReminderAt: null,
      reportedAt: null,
      falsePositiveAt: null,
      image: READY,
    });
  });

  it('returns the times a reminder and a prior verdict were recorded', async () => {
    const lastReminderAt = new Date('2026-10-31T08:00:00Z');
    const reportedAt = new Date('2026-10-31T09:00:00Z');
    const falsePositiveAt = new Date('2026-10-30T12:00:00Z');
    m.findById.mockResolvedValue({ ...INCIDENT, lastReminderAt, reportedAt, falsePositiveAt });
    const res = makeRes();
    await runHandler(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ lastReminderAt, reportedAt, falsePositiveAt }));
  });

  it('keeps the user id when the account is gone, and nulls what the incident never had', async () => {
    m.findUserById.mockResolvedValue(null);
    m.findById.mockResolvedValue({
      ...INCIDENT,
      surface: undefined,
      sessionId: undefined,
      questId: undefined,
      labels: undefined,
    });
    const res = makeRes();
    await runHandler(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: null,
        user: { id: USER_ID, email: null },
        labels: [],
        sessionId: null,
        questId: null,
      })
    );
  });

  it('does not look the user up when the view cannot be recorded', async () => {
    m.record.mockRejectedValue(new Error('audit write failed'));
    await expect(runHandler(makeReq(), makeRes())).rejects.toThrow('audit write failed');
    expect(m.findUserById).not.toHaveBeenCalled();
  });

  it('accepts JWT sessions only, never an API key', () => {
    expect(m.adminApiOptions).toMatchObject({ auth: 'jwtOnly' });
  });

  it('refuses a delegated admin before any lookup, audit or signing', async () => {
    await expect(
      runHandler(makeReq({ user: { id: 'delegate', isAdmin: false, adminPermissions: ['users:moderate'] } }), makeRes())
    ).rejects.toThrow('Admin access required');
    expect(m.findById).not.toHaveBeenCalled();
    expect(m.findUserById).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
    expect(m.sign).not.toHaveBeenCalled();
  });

  it('propagates a missing step-up without auditing or signing', async () => {
    m.requireStepUp.mockRejectedValue(new Error('Recent verification required'));
    await expect(runHandler(makeReq(), makeRes())).rejects.toThrow('Recent verification required');
    expect(m.findById).not.toHaveBeenCalled();
    expect(m.findUserById).not.toHaveBeenCalled();
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
    m.findById.mockResolvedValue({ ...INCIDENT, reviewStatus: 'reported', previousReviewStatus: 'no_action' });
    const res = makeRes();
    await runHandler(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ reviewStatus: 'reported', previousReviewStatus: 'no_action' })
    );
  });
});
