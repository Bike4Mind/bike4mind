import { describe, it, expect } from 'vitest';
import { RISK_EVIDENCE_VERSION, type RiskEvidenceSummary, type SignupRiskReviewState } from '@bike4mind/common';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

let seq = 0;
const createUser = async (set: Record<string, unknown> = {}) => {
  seq += 1;
  const user = await User.create({ username: `evidence${seq}`, name: 'Evidence', email: `evidence${seq}@example.com` });
  // Raw driver write: mongoose timestamps make createdAt immutable through the model.
  if (Object.keys(set).length > 0) await User.collection.updateOne({ _id: user._id }, { $set: set });
  return user.id as string;
};

const summaryAt = (computedAt: Date, created = 1): RiskEvidenceSummary => ({
  version: RISK_EVIDENCE_VERSION,
  computedAt,
  window: { from: new Date('2026-10-01T00:00:00Z'), to: computedAt },
  trigger: 'api_key_created',
  facts: {
    signupNetwork: { status: 'missing', provenance: 'signup_request', reason: 'not_captured' },
    edgeFingerprint: { status: 'missing', provenance: 'signup_request', reason: 'not_captured' },
    wafSignals: { status: 'missing', provenance: 'signup_request', reason: 'not_captured' },
    authActivity: { status: 'failed', provenance: 'auth_events', error: 'timeout' },
    apiKeys: {
      status: 'observed',
      provenance: 'api_key_records',
      value: { created, minutesToFirstKey: 2 },
      sampleCount: created,
      latestAt: computedAt,
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
});

const stored = async (id: string) => (await User.findById(id).lean())?.riskEvidence;

describe('UserRepository risk evidence', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const staleBefore = new Date('2026-10-30T11:45:00Z');

  describe('claimRiskEvidenceRefresh', () => {
    it('claims an account with no refresh pending, and dedupes the next request', async () => {
      const id = await createUser();

      expect(await userRepository.claimRiskEvidenceRefresh(id, { now, staleBefore, trigger: 'login' })).toBe(true);
      expect(await userRepository.claimRiskEvidenceRefresh(id, { now, staleBefore, trigger: 'completion' })).toBe(
        false
      );
      expect((await stored(id))?.refresh).toMatchObject({ pendingSince: now, lastTrigger: 'login' });
    });

    it('reclaims a pending refresh older than staleBefore, whose message was lost', async () => {
      const id = await createUser({ riskEvidence: { refresh: { pendingSince: new Date('2026-10-30T10:00:00Z') } } });

      expect(await userRepository.claimRiskEvidenceRefresh(id, { now, staleBefore, trigger: 'sweep' })).toBe(true);
    });

    it('claims again once the running refresh released it', async () => {
      const id = await createUser();
      await userRepository.claimRiskEvidenceRefresh(id, { now, staleBefore, trigger: 'login' });

      await userRepository.releaseRiskEvidenceRefresh(id, now);

      expect(await userRepository.claimRiskEvidenceRefresh(id, { now, staleBefore, trigger: 'login' })).toBe(true);
    });

    it('leaves a newer claim in place when released with a different claimedAt', async () => {
      const id = await createUser();
      await userRepository.claimRiskEvidenceRefresh(id, { now, staleBefore, trigger: 'login' });

      await userRepository.releaseRiskEvidenceRefresh(id, new Date('2026-10-30T11:50:00Z'));

      expect((await stored(id))?.refresh?.pendingSince).toEqual(now);
      expect(await userRepository.claimRiskEvidenceRefresh(id, { now, staleBefore, trigger: 'login' })).toBe(false);
    });
  });

  describe('setRiskEvidenceSummary', () => {
    it('stores a first summary and clears a recorded failure', async () => {
      const id = await createUser();
      await userRepository.recordRiskEvidenceFailure(id, { at: now, error: 'boom' });

      expect(await userRepository.setRiskEvidenceSummary(id, summaryAt(now))).toBe(true);

      const evidence = await stored(id);
      expect(evidence?.summary).toEqual(summaryAt(now));
      expect(evidence?.refresh).toMatchObject({ lastFailure: null, lastFailureAt: null });
    });

    it('does not let an older summary overwrite a newer one', async () => {
      const id = await createUser();
      await userRepository.setRiskEvidenceSummary(id, summaryAt(now, 3));

      const older = summaryAt(new Date('2026-10-30T11:00:00Z'), 1);
      expect(await userRepository.setRiskEvidenceSummary(id, older)).toBe(false);

      expect((await stored(id))?.summary?.computedAt).toEqual(now);
    });

    it.each(['none', 'pending', 'approved', 'banned'] as const)(
      'leaves riskScore and a %s review untouched',
      async (reviewState: SignupRiskReviewState) => {
        const riskScore = { score: 10, signals: [], computedAt: new Date('2026-10-29T00:00:00Z'), reviewState };
        const id = await createUser({ riskScore });

        await userRepository.setRiskEvidenceSummary(id, summaryAt(now));
        await userRepository.recordRiskEvidenceFailure(id, { at: now, error: 'boom' });

        expect((await User.findById(id).lean())?.riskScore).toEqual(riskScore);
      }
    );
  });

  describe('recordRiskEvidenceFailure', () => {
    it('keeps the last good summary and caps the stored error', async () => {
      const id = await createUser();
      await userRepository.setRiskEvidenceSummary(id, summaryAt(now));

      await userRepository.recordRiskEvidenceFailure(id, { at: now, error: 'x'.repeat(500) });

      const evidence = await stored(id);
      expect(evidence?.summary?.computedAt).toEqual(now);
      expect(evidence?.refresh?.lastFailure).toHaveLength(200);
    });
  });

  describe('riskEvidenceCoverage', () => {
    it('counts signup metadata, JA4 and WAF coverage of accounts created since the cutoff', async () => {
      const since = new Date('2026-10-01T00:00:00Z');
      const recent = new Date('2026-10-20T00:00:00Z');
      const meta = { ip: null, userAgent: null, asn: null, asnOrg: null, country: null, isDatacenter: null };
      await createUser({ createdAt: recent });
      await createUser({ createdAt: recent, signupMeta: { ...meta, capturedAt: recent } });
      await createUser({
        createdAt: recent,
        signupMeta: { ...meta, ja4: 't13d1516h2_8daaf6152771_02713d6af862', capturedAt: recent },
      });
      await createUser({
        createdAt: recent,
        signupMeta: { ...meta, wafAnonIp: false, wafBotSignal: true, capturedAt: recent },
      });
      await createUser({ createdAt: new Date('2026-09-01T00:00:00Z'), signupMeta: { ...meta, capturedAt: recent } });
      // Explicit nulls and a half-populated WAF pair are unknown, not covered.
      await createUser({
        createdAt: recent,
        signupMeta: { ...meta, ja4: null, wafAnonIp: null, wafBotSignal: null, capturedAt: recent },
      });
      await createUser({
        createdAt: recent,
        signupMeta: { ...meta, wafAnonIp: true, wafBotSignal: null, capturedAt: recent },
      });

      expect(await userRepository.riskEvidenceCoverage(since)).toEqual({
        accounts: 6,
        withSignupMeta: 5,
        withJa4: 1,
        withWafSignals: 1,
      });
    });
  });
});
