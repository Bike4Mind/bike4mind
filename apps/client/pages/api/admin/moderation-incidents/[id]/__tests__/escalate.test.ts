// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  escalate: vi.fn(),
  findById: vi.fn(),
  findUserById: vi.fn(),
  record: vi.fn(),
  requireStepUp: vi.fn(),
  sendAlert: vi.fn(),
  txActive: false,
  inTransaction: [] as boolean[],
  adminApiOptions: undefined as unknown,
}));

vi.mock('@bike4mind/database', () => ({
  imageModerationIncidentRepository: { escalate: m.escalate, findById: m.findById },
  withTransaction: async (fn: () => Promise<unknown>) => {
    m.txActive = true;
    try {
      return await fn();
    } finally {
      m.txActive = false;
    }
  },
}));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    m.adminApiOptions = options;
    return { post: (h: (...args: unknown[]) => unknown) => h };
  },
}));
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: m.requireStepUp }));
vi.mock('@bike4mind/server-utils/moderation/imageModerationIncidents', () => ({
  sendIncidentEscalationAlert: m.sendAlert,
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: m.record,
  userAuditTarget: async (id: string) => {
    const user = await m.findUserById(id);
    return { kind: 'user', id, displayName: user?.email ?? id };
  },
}));

import handler from '../escalate';

const runHandler = handler as unknown as (req: unknown, res: unknown) => Promise<void>;

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const USER_ID = 'cccccccccccccccccccccccc';
const REASON = 'Needs a second opinion';
const CREATED_AT = new Date('2026-10-30T10:00:00Z');
const ESCALATED_AT = new Date('2026-10-30T12:00:00Z');
const ALERTED_AT = new Date('2026-10-30T12:00:01Z');
const ESCALATED = {
  id: ID,
  userId: USER_ID,
  createdAt: CREATED_AT,
  surface: 'generation',
  reviewStatus: 'pending_review',
  escalatedAt: ESCALATED_AT,
  escalatedBy: 'admin-1',
  escalationTrigger: 'manual',
  labels: [{ name: 'Example label', parentName: '', confidence: 90 }],
};

const makeRes = () => {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};
const makeReq = (body: Record<string, unknown> = { reason: REASON }, id: unknown = ID) => ({
  method: 'POST',
  user: { id: 'admin-1', isAdmin: true },
  query: { id },
  body,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});
const jsonOf = (res: Record<string, unknown>) => (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];

describe('admin/moderation-incidents/[id]/escalate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.inTransaction = [];
    m.requireStepUp.mockResolvedValue(undefined);
    m.escalate.mockResolvedValue(ESCALATED);
    m.findUserById.mockResolvedValue({ id: USER_ID, email: 'flagged@example.com' });
    m.record.mockImplementation(async () => void m.inTransaction.push(m.txActive));
    m.sendAlert.mockResolvedValue({ outcome: 'delivered', alertedAt: ALERTED_AT, queuedAt: null });
  });

  it('takes the moderation permission on a signed-in session only', () => {
    expect(m.adminApiOptions).toEqual({
      auth: 'jwtOnly',
      requiredScopes: ['admin:*'],
      adminPermissions: { POST: 'users:moderate' },
    });
  });

  it('stamps a manual escalation and audits it with the reason in the same transaction', async () => {
    const req = makeReq();
    const res = makeRes();
    await runHandler(req, res);

    expect(m.escalate).toHaveBeenCalledExactlyOnceWith(ID, { trigger: 'manual', by: 'admin-1' });
    expect(m.record).toHaveBeenCalledExactlyOnceWith(req, {
      action: 'moderation.incident.escalated',
      target: { kind: 'user', id: USER_ID, displayName: 'flagged@example.com' },
      summary: `escalated moderation incident ${ID}`,
      reason: REASON,
      details: { incidentId: ID, trigger: 'manual' },
    });
    expect(m.inTransaction).toEqual([true]);
    expect(m.escalate.mock.invocationCallOrder[0]).toBeLessThan(m.record.mock.invocationCallOrder[0]);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it.each([
    ['delivered', ALERTED_AT, null],
    ['queued', null, ALERTED_AT],
    ['no_recipients', null, null],
    ['failed', null, null],
  ] as const)(
    'returns the incident and the %s email outcome after the commit',
    async (outcome, alertedAt, queuedAt) => {
      m.sendAlert.mockImplementation(async () => {
        expect(m.txActive).toBe(false);
        return { outcome, alertedAt, queuedAt };
      });
      const res = makeRes();
      await runHandler(makeReq(), res);

      // Only metadata reaches the email: never labels or the flagged user.
      expect(m.sendAlert).toHaveBeenCalledExactlyOnceWith({ id: ID, createdAt: CREATED_AT, surface: 'generation' });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(jsonOf(res)).toEqual({
        ok: true,
        incident: {
          id: ID,
          reviewStatus: 'pending_review',
          escalatedAt: ESCALATED_AT,
          escalationTrigger: 'manual',
          escalationAlertedAt: alertedAt,
          escalationAlertQueuedAt: queuedAt,
        },
        alert: outcome,
      });
    }
  );

  it('requires a recent step-up before any side effect', async () => {
    const stepUpRequired = Object.assign(new Error('Recent verification required'), {
      statusCode: 403,
      code: 'step_up_required',
    });
    m.requireStepUp.mockRejectedValue(stepUpRequired);
    const req = makeReq();

    await expect(runHandler(req, makeRes())).rejects.toBe(stepUpRequired);

    expect(m.requireStepUp).toHaveBeenCalledWith(req);
    for (const mock of [m.escalate, m.findById, m.record, m.sendAlert]) expect(mock).not.toHaveBeenCalled();
  });

  it.each([{}, { reason: '' }, { reason: 'ok' }, { reason: 42 }])(
    'refuses a missing or short reason %j with a 400 and no side effects',
    async body => {
      await expect(runHandler(makeReq(body), makeRes())).rejects.toMatchObject({ statusCode: 400 });
      for (const mock of [m.escalate, m.record, m.sendAlert]) expect(mock).not.toHaveBeenCalled();
    }
  );

  it('answers 404 for a malformed id without querying', async () => {
    const res = makeRes();
    await runHandler(makeReq(undefined, 'not-an-id'), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(m.escalate).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown incident', async () => {
    m.escalate.mockResolvedValue(null);
    m.findById.mockResolvedValue(null);
    const res = makeRes();
    await runHandler(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(m.record).not.toHaveBeenCalled();
    expect(m.sendAlert).not.toHaveBeenCalled();
  });

  it('answers 409 for an incident that is already escalated, with no audit entry or email', async () => {
    m.escalate.mockResolvedValue(null);
    m.findById.mockResolvedValue({ ...ESCALATED, escalatedBy: 'admin-0' });
    const res = makeRes();
    await runHandler(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(jsonOf(res)).toEqual({ error: 'Incident is already escalated' });
    expect(m.record).not.toHaveBeenCalled();
    expect(m.sendAlert).not.toHaveBeenCalled();
  });

  it.each(['no_action', 'false_positive', 'reported', 'confirmed_csam'])(
    'answers 409 for an incident in %s',
    async reviewStatus => {
      m.escalate.mockResolvedValue(null);
      m.findById.mockResolvedValue({ ...ESCALATED, reviewStatus });
      const res = makeRes();
      await runHandler(makeReq(), res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(jsonOf(res)).toEqual({ error: `Incident is already ${reviewStatus}` });
    }
  );

  it('sends no email when the audit write fails, so the rolled-back escalation is never announced', async () => {
    m.record.mockRejectedValue(new Error('audit down'));
    const res = makeRes();
    await expect(runHandler(makeReq(), res)).rejects.toThrow('audit down');
    expect(m.sendAlert).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(200);
  });

  it('never logs the reason or a recipient', async () => {
    const req = makeReq();
    await runHandler(req, makeRes());
    const logged = JSON.stringify([
      req.logger.info.mock.calls,
      req.logger.warn.mock.calls,
      req.logger.error.mock.calls,
    ]);
    expect(logged).toContain(ID);
    expect(logged).not.toContain(REASON);
    expect(logged).not.toContain('@');
  });
});
