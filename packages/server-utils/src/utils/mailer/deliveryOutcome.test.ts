import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ record: vi.fn(), recordAlert: vi.fn(), reconcile: vi.fn(), logError: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  emailSendAttemptRepository: { recordDeliveryOutcome: mocks.record },
  imageModerationIncidentRepository: { recordAlertDelivery: mocks.recordAlert },
}));
vi.mock('../../email/reconcileEmailJob', () => ({ reconcileEmailJob: mocks.reconcile }));
vi.mock('@bike4mind/observability', () => ({ Logger: { error: mocks.logError } }));

import { recordEmailDeliveryOutcome } from './deliveryOutcome';

const ref = { kind: 'emailAttempt' as const, attemptId: 'attempt-1' };
const ok = { ok: true as const, at: new Date('2026-01-01T00:00:00Z') };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.record.mockResolvedValue('job-1');
});

describe('recordEmailDeliveryOutcome', () => {
  it('writes the outcome to the attempt and recounts its job', async () => {
    await recordEmailDeliveryOutcome(ref, ok);
    expect(mocks.record).toHaveBeenCalledWith('attempt-1', ok);
    expect(mocks.reconcile).toHaveBeenCalledWith('job-1');
  });

  it('skips the recount when the attempt was already past this outcome', async () => {
    mocks.record.mockResolvedValue(null);
    await recordEmailDeliveryOutcome(ref, { ok: false, error: 'x' });
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('logs the attempt id and resolves when the write throws', async () => {
    mocks.record.mockRejectedValue(new Error('db down'));
    await expect(recordEmailDeliveryOutcome(ref, ok)).resolves.toBeUndefined();
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining('emailAttempt attempt-1: db down'));
  });

  it('routes an incident alert outcome to the incident, never to an attempt', async () => {
    const failed = { ok: false as const, error: 'rejected' };
    await recordEmailDeliveryOutcome({ kind: 'incidentAlert', incidentId: 'inc-1', alert: 'escalation' }, failed);
    expect(mocks.recordAlert).toHaveBeenCalledWith('inc-1', 'escalation', failed);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('logs the incident id and resolves when the incident write throws', async () => {
    mocks.recordAlert.mockRejectedValue(new Error('db down'));
    await expect(
      recordEmailDeliveryOutcome({ kind: 'incidentAlert', incidentId: 'inc-1', alert: 'review' }, ok)
    ).resolves.toBeUndefined();
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining('incidentAlert inc-1: db down'));
  });

  it('resolves when the recount throws', async () => {
    mocks.reconcile.mockRejectedValue(new Error('db down'));
    await expect(recordEmailDeliveryOutcome(ref, ok)).resolves.toBeUndefined();
  });
});
