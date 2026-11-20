import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { MODERATION_PAGE_READ, RISK_EVIDENCE_VERSION, missingAdminPermissionMessage } from '@bike4mind/common';

const { mockUserFind } = vi.hoisted(() => ({ mockUserFind: vi.fn() }));

vi.mock('@server/middlewares/adminApi', async () =>
  (await import('@server/middlewares/__tests__/adminApiMock')).adminApiMock()
);

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockUserFind(...a) },
}));

import handler from '../risk-evidence';

const USER_ID = '64b7f0c2a1b2c3d4e5f60718';
const ADMIN = { id: 'admin1', isAdmin: true };
const COMPUTED_AT = new Date('2026-10-30T12:00:00Z');

const run = ({ user = ADMIN as unknown, userId = USER_ID } = {}) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId } });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const summary = {
  version: RISK_EVIDENCE_VERSION,
  computedAt: COMPUTED_AT,
  window: { from: new Date('2026-10-20T00:00:00Z'), to: COMPUTED_AT },
  trigger: 'login',
  facts: {
    signupNetwork: { status: 'missing', provenance: 'signup_request', reason: 'not_captured' },
    edgeFingerprint: { status: 'missing', provenance: 'signup_request', reason: 'not_captured' },
    wafSignals: { status: 'missing', provenance: 'signup_request', reason: 'not_captured' },
    authActivity: { status: 'failed', provenance: 'auth_events', error: 'timeout' },
    apiKeys: {
      status: 'observed',
      provenance: 'api_key_records',
      value: { created: 0, minutesToFirstKey: null },
      sampleCount: 0,
      latestAt: null,
      truncated: false,
    },
    usage: { status: 'missing', provenance: 'usage_ledger', reason: 'no_activity' },
    concurrency: {
      status: 'observed',
      provenance: 'execution_state',
      value: { activeAgentExecutions: 0 },
      sampleCount: 1,
      latestAt: null,
      truncated: false,
    },
    sensitiveActions: { status: 'missing', provenance: 'auth_audit_log', reason: 'no_activity' },
  },
};

const refresh = { pendingSince: null, lastTrigger: 'login', lastFailureAt: COMPUTED_AT, lastFailure: 'boom' };

beforeEach(() => {
  mockUserFind.mockReset();
});

describe('GET /api/admin/users/:userId/risk-evidence', () => {
  it('declares MODERATION_PAGE_READ for GET', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual(
      expect.objectContaining({ adminPermissions: { GET: MODERATION_PAGE_READ } })
    );
  });

  it('refuses a delegate without a moderation read permission before reading the user', async () => {
    const user = { id: 'u2', isAdmin: false, adminPermissions: ['credits:adjust'] };
    await expect(run({ user }).promise).rejects.toMatchObject({
      statusCode: 403,
      message: missingAdminPermissionMessage(MODERATION_PAGE_READ),
    });
    expect(mockUserFind).not.toHaveBeenCalled();
  });

  it.each(['support:read', 'users:moderate'])('admits a delegate holding %s', async permission => {
    mockUserFind.mockResolvedValue({ id: USER_ID });
    const { res, promise } = run({ user: { id: 'u2', isAdmin: false, adminPermissions: [permission] } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserFind).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed user id', async () => {
    await expect(run({ userId: 'nope' }).promise).rejects.toThrow('Invalid user id');
  });

  it('404s an unknown user', async () => {
    mockUserFind.mockResolvedValue(null);
    await expect(run().promise).rejects.toThrow('User not found');
  });

  it('returns the score, the evidence and the refresh state side by side', async () => {
    mockUserFind.mockResolvedValue({
      id: USER_ID,
      riskScore: { score: 40, signals: [], computedAt: COMPUTED_AT, reviewState: 'none' },
      riskEvidence: { summary, refresh },
    });

    const { res, promise } = run();
    await promise;

    const body = res._getJSONData();
    expect(body.riskScore).toMatchObject({ score: 40, reviewState: 'none' });
    expect(body.evidence).toMatchObject({ version: RISK_EVIDENCE_VERSION, trigger: 'login' });
    expect(body.evidence.facts.authActivity).toEqual({ status: 'failed', provenance: 'auth_events', error: 'timeout' });
    expect(body.refresh).toMatchObject({ lastFailure: 'boom' });
  });

  it('reads an unrecognized summary version as no evidence instead of misreading it', async () => {
    mockUserFind.mockResolvedValue({ id: USER_ID, riskEvidence: { summary: { ...summary, version: 0 }, refresh } });

    const { res, promise } = run();
    await promise;

    expect(res._getJSONData()).toMatchObject({
      riskScore: null,
      evidence: null,
      evidenceUnreadable: true,
      refresh: { lastFailure: 'boom' },
    });
  });

  it('returns nulls for an account never assessed', async () => {
    mockUserFind.mockResolvedValue({ id: USER_ID });

    const { res, promise } = run();
    await promise;

    expect(res._getJSONData()).toEqual({ riskScore: null, evidence: null, evidenceUnreadable: false, refresh: null });
  });

  it('reads an invalid risk score as null while still returning the evidence', async () => {
    mockUserFind.mockResolvedValue({
      id: USER_ID,
      riskScore: {
        score: 40,
        signals: [{ signal: 'not_a_signal', points: 10, reason: 'x' }],
        computedAt: COMPUTED_AT,
        reviewState: 'none',
      },
      riskEvidence: { summary, refresh },
    });

    const { res, promise } = run();
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      riskScore: null,
      evidence: { version: RISK_EVIDENCE_VERSION },
      evidenceUnreadable: false,
    });
  });
});
