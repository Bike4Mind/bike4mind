import { describe, it, expect, vi } from 'vitest';
import {
  RISK_EVIDENCE_SCAN_LIMIT,
  riskEvidenceSummarySchema,
  type ISignupMeta,
  type RiskEvidenceSummary,
} from '@bike4mind/common';
import {
  RISK_EVIDENCE_DEBOUNCE_SECONDS,
  refreshRiskEvidence,
  requestRiskEvidenceRefresh,
  type RefreshRiskEvidenceAdapters,
} from './riskEvidence';

const USER_ID = '64b7f0c2a1b2c3d4e5f60718';
const SIGNED_UP = new Date('2026-10-20T10:00:00Z');
const NOW = new Date('2026-10-21T10:00:00Z');
const minutesAfterSignup = (minutes: number) => new Date(SIGNED_UP.getTime() + minutes * 60_000);

const SIGNUP_META: ISignupMeta = {
  ip: '203.0.113.7',
  userAgent: 'ua',
  asn: 16509,
  asnOrg: 'AMAZON-02',
  country: 'US',
  isDatacenter: true,
  ja4: null,
  wafAnonIp: null,
  wafBotSignal: null,
  capturedAt: SIGNED_UP,
};

const setup = ({
  user = {} as Record<string, unknown> | null,
  authEvents = [] as { type: string; createdAt: Date; ip?: string | null; asn?: number | null }[],
  auditLogs = [] as { event: string; createdAt: Date }[],
  firstKeyAt = null as Date | null,
  keysCreated = 0,
  usage = { events: 0, completed: 0, failed: 0, credits: 0, latestAt: null as Date | null },
  storeWins = true,
} = {}) => {
  const stored: RiskEvidenceSummary[] = [];
  const users = {
    findById: vi.fn(async (id: string) =>
      user === null ? null : { id, createdAt: SIGNED_UP, signupMeta: null, riskScore: null, ...user }
    ),
    releaseRiskEvidenceRefresh: vi.fn(async () => undefined),
    setRiskEvidenceSummary: vi.fn(async (_id: string, summary: RiskEvidenceSummary) => {
      stored.push(summary);
      return storeWins;
    }),
    recordRiskEvidenceFailure: vi.fn(async () => undefined),
    // Present to prove refreshRiskEvidence never reaches the score that sets reviewState.
    setRiskScore: vi.fn(),
    setRiskReviewState: vi.fn(),
  };
  const adapters: RefreshRiskEvidenceAdapters = {
    db: {
      users: users as unknown as RefreshRiskEvidenceAdapters['db']['users'],
      authEvents: { findByUser: vi.fn(async () => authEvents) },
      authAuditLogs: { findByUser: vi.fn(async () => auditLogs) },
      userApiKeys: {
        findFirstCreatedAtByUserId: vi.fn(async () => firstKeyAt),
        countCreatedByUserIds: vi.fn(async () => (keysCreated ? { [USER_ID]: keysCreated } : {})),
      },
      usageEvents: { activitySummaryByUser: vi.fn(async () => usage) },
      agentExecutions: { countActiveByUserId: vi.fn(async () => 2) },
    },
    now: () => NOW,
  };
  return { adapters, users, stored };
};

const REQUESTED_AT = new Date('2026-10-30T11:59:00Z');
const refresh = (adapters: RefreshRiskEvidenceAdapters) =>
  refreshRiskEvidence(USER_ID, 'login', { requestedAt: REQUESTED_AT, ...adapters });

describe('refreshRiskEvidence', () => {
  it('stores a valid, versioned summary with an explicit observation window', async () => {
    const { adapters, stored } = setup();

    const outcome = await refresh(adapters);

    expect(outcome.status).toBe('stored');
    expect(() => riskEvidenceSummarySchema.parse(stored[0])).not.toThrow();
    expect(stored[0]).toMatchObject({
      version: 1,
      computedAt: NOW,
      trigger: 'login',
      window: { from: SIGNED_UP, to: NOW },
    });
  });

  it('releases the pending claim before reading, so activity during the refresh queues another', async () => {
    const { adapters, users } = setup();

    await refresh(adapters);

    expect(users.releaseRiskEvidenceRefresh.mock.invocationCallOrder[0]).toBeLessThan(
      users.findById.mock.invocationCallOrder[0]
    );
  });

  it('releases the claim stamped with the request time', async () => {
    const { adapters, users } = setup();

    await refresh(adapters);

    expect(users.releaseRiskEvidenceRefresh).toHaveBeenCalledWith(USER_ID, REQUESTED_AT);
  });

  it('marks signup facts not_captured when the account has no signup metadata', async () => {
    const { adapters, stored } = setup();

    await refresh(adapters);

    const { signupNetwork, edgeFingerprint, wafSignals } = stored[0].facts;
    for (const fact of [signupNetwork, edgeFingerprint, wafSignals]) {
      expect(fact).toEqual({ status: 'missing', provenance: 'signup_request', reason: 'not_captured' });
    }
  });

  it('keeps a null JA4 and null WAF fields unknown rather than clean', async () => {
    const { adapters, stored } = setup({ user: { signupMeta: SIGNUP_META } });

    await refresh(adapters);

    const { signupNetwork, edgeFingerprint, wafSignals } = stored[0].facts;
    expect(signupNetwork).toMatchObject({
      status: 'observed',
      value: { isDatacenter: true, asnKnown: true, challengeVerified: false },
    });
    expect(edgeFingerprint).toMatchObject({ status: 'missing', reason: 'not_captured' });
    expect(wafSignals).toMatchObject({ status: 'missing', reason: 'not_captured' });
  });

  it('records WAF signals and JA4 presence when the edge forwarded them', async () => {
    const meta = { ...SIGNUP_META, ja4: 't13d1516h2_8daaf6152771_02713d6af862', wafAnonIp: false, wafBotSignal: true };
    const { adapters, stored } = setup({ user: { signupMeta: meta } });

    await refresh(adapters);

    expect(stored[0].facts.edgeFingerprint).toMatchObject({ status: 'observed', value: { ja4Present: true } });
    expect(stored[0].facts.wafSignals).toMatchObject({ status: 'observed', value: { anonIp: false, botSignal: true } });
  });

  it('marks one fact failed when its source errors, and still stores the rest', async () => {
    const { adapters, stored } = setup({ keysCreated: 1, firstKeyAt: minutesAfterSignup(5) });
    adapters.db.usageEvents.activitySummaryByUser = vi.fn(async () => {
      throw new Error('usage read timed out');
    });

    const outcome = await refresh(adapters);

    expect(outcome.status).toBe('stored');
    expect(stored[0].facts.usage).toEqual({
      status: 'failed',
      provenance: 'usage_ledger',
      error: 'usage read timed out',
    });
    expect(stored[0].facts.apiKeys).toMatchObject({ status: 'observed', value: { created: 1 } });
  });

  it('separates no recorded activity from zero counts it observed', async () => {
    const { adapters, stored } = setup();

    await refresh(adapters);

    expect(stored[0].facts.usage).toMatchObject({ status: 'missing', reason: 'no_activity' });
    expect(stored[0].facts.authActivity).toMatchObject({ status: 'missing', reason: 'no_activity' });
    expect(stored[0].facts.apiKeys).toMatchObject({
      status: 'observed',
      value: { created: 0, minutesToFirstKey: null },
    });
    expect(stored[0].facts.concurrency).toMatchObject({
      status: 'observed',
      value: { activeAgentExecutions: 2 },
      latestAt: null,
    });
  });

  it('summarizes auth activity in the window with sample counts and freshness', async () => {
    const latest = minutesAfterSignup(60);
    const { adapters, stored } = setup({
      authEvents: [
        { type: 'login', createdAt: latest, ip: '203.0.113.7', asn: 16509 },
        { type: 'login', createdAt: minutesAfterSignup(30), ip: '198.51.100.2', asn: 16509 },
        { type: 'signup', createdAt: SIGNED_UP, ip: '203.0.113.7', asn: null },
      ],
    });

    await refresh(adapters);

    expect(stored[0].facts.authActivity).toEqual({
      status: 'observed',
      provenance: 'auth_events',
      value: { logins: 2, signups: 1, distinctIps: 2, distinctNetworks: 1 },
      sampleCount: 3,
      latestAt: latest,
      truncated: false,
    });
  });

  it('flags a scan that hit the row cap inside the window as truncated', async () => {
    const authEvents = Array.from({ length: RISK_EVIDENCE_SCAN_LIMIT }, () => ({
      type: 'login',
      createdAt: minutesAfterSignup(10),
    }));
    const { adapters, stored } = setup({ authEvents });

    await refresh(adapters);

    expect(stored[0].facts.authActivity).toMatchObject({ status: 'observed', truncated: true });
  });

  it('counts only the sensitive audit outcomes it tracks', async () => {
    const { adapters, stored } = setup({
      auditLogs: [
        { event: 'step_up_failed', createdAt: minutesAfterSignup(3) },
        { event: 'step_up_failed', createdAt: minutesAfterSignup(4) },
        { event: 'login_success', createdAt: minutesAfterSignup(5) },
        { event: 'mfa_disabled', createdAt: minutesAfterSignup(6) },
      ],
    });

    await refresh(adapters);

    expect(stored[0].facts.sensitiveActions).toMatchObject({
      status: 'observed',
      value: { stepUpFailed: 2, stepUpSucceeded: 0, emailChangeFailed: 0, mfaDisabled: 1, sessionReuseRevoked: 0 },
      sampleCount: 3,
    });
  });

  it('records legitimate fast API-key creation as evidence without touching the review state', async () => {
    const { adapters, stored, users } = setup({ keysCreated: 1, firstKeyAt: minutesAfterSignup(2) });

    await refresh(adapters);

    expect(stored[0].facts.apiKeys).toMatchObject({ value: { created: 1, minutesToFirstKey: 2 } });
    expect(users.setRiskScore).not.toHaveBeenCalled();
    expect(users.setRiskReviewState).not.toHaveBeenCalled();
  });

  it.each(['none', 'pending', 'approved', 'banned'] as const)(
    'never writes the score or reviewState of a %s account',
    async reviewState => {
      const { adapters, users } = setup({
        user: { riskScore: { score: 90, signals: [], computedAt: SIGNED_UP, reviewState } },
        keysCreated: 3,
        firstKeyAt: minutesAfterSignup(1),
        usage: { events: 40, completed: 40, failed: 0, credits: 5000, latestAt: NOW },
      });

      await refresh(adapters);

      expect(users.setRiskEvidenceSummary).toHaveBeenCalledTimes(1);
      expect(users.setRiskScore).not.toHaveBeenCalled();
      expect(users.setRiskReviewState).not.toHaveBeenCalled();
    }
  );

  it('produces the same summary when the same trigger is replayed', async () => {
    const { adapters, stored } = setup({
      keysCreated: 1,
      firstKeyAt: minutesAfterSignup(10),
      usage: { events: 3, completed: 3, failed: 0, credits: 12, latestAt: minutesAfterSignup(20) },
    });

    await refresh(adapters);
    await refresh(adapters);

    expect(stored[1]).toEqual(stored[0]);
  });

  it('reports a summary that lost the race to a newer one as superseded', async () => {
    const { adapters } = setup({ storeWins: false });

    expect((await refresh(adapters)).status).toBe('superseded');
  });

  it('is a no-op for a deleted account', async () => {
    const { adapters, users } = setup({ user: null });

    expect(await refresh(adapters)).toEqual({ status: 'no_user' });
    expect(users.setRiskEvidenceSummary).not.toHaveBeenCalled();
  });

  it('records the failure for admins and rethrows so the queue retries', async () => {
    const { adapters, users } = setup();
    users.setRiskEvidenceSummary.mockRejectedValueOnce(new Error('write conflict'));

    await expect(refresh(adapters)).rejects.toThrow('write conflict');
    expect(users.recordRiskEvidenceFailure).toHaveBeenCalledWith(USER_ID, { at: NOW, error: 'write conflict' });
  });
});

describe('requestRiskEvidenceRefresh', () => {
  const requestSetup = (claimed: boolean) => {
    const users = {
      claimRiskEvidenceRefresh: vi.fn(async () => claimed),
      releaseRiskEvidenceRefresh: vi.fn(async () => undefined),
    };
    const enqueue = vi.fn(async () => undefined);
    const warn = vi.fn();
    return { users, enqueue, warn, adapters: { users, enqueue, logger: { warn }, now: NOW } };
  };

  it('claims and queues a delayed refresh', async () => {
    const { adapters, enqueue, users } = requestSetup(true);

    await expect(requestRiskEvidenceRefresh(USER_ID, 'api_key_created', adapters)).resolves.toBe('queued');

    expect(users.claimRiskEvidenceRefresh).toHaveBeenCalledWith(USER_ID, {
      now: NOW,
      staleBefore: new Date(NOW.getTime() - 15 * 60_000),
      trigger: 'api_key_created',
    });
    expect(enqueue).toHaveBeenCalledWith(
      { kind: 'refresh', userId: USER_ID, trigger: 'api_key_created', requestedAt: NOW },
      RISK_EVIDENCE_DEBOUNCE_SECONDS
    );
  });

  it('dedupes while a refresh is already pending', async () => {
    const { adapters, enqueue } = requestSetup(false);

    await expect(requestRiskEvidenceRefresh(USER_ID, 'completion', adapters)).resolves.toBe('deduped');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never throws, and releases a claim whose message failed to send', async () => {
    const { adapters, enqueue, users, warn } = requestSetup(true);
    enqueue.mockRejectedValueOnce(new Error('sqs down'));

    await expect(requestRiskEvidenceRefresh(USER_ID, 'login', adapters)).resolves.toBe('failed');
    expect(users.releaseRiskEvidenceRefresh).toHaveBeenCalledWith(USER_ID, NOW);
    expect(warn).toHaveBeenCalledWith('Risk evidence refresh not queued', expect.objectContaining({ userId: USER_ID }));
  });

  it('never throws when the claim itself fails', async () => {
    const { adapters, users } = requestSetup(true);
    users.claimRiskEvidenceRefresh.mockRejectedValueOnce(new Error('mongo down'));

    await expect(requestRiskEvidenceRefresh(USER_ID, 'login', adapters)).resolves.toBe('failed');
    expect(users.releaseRiskEvidenceRefresh).not.toHaveBeenCalled();
  });
});
