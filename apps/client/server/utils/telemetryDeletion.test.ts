import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUpdateMany, mockCountDocuments, mockAuditCreate, mockHashes } = vi.hoisted(() => ({
  mockUpdateMany: vi.fn(),
  mockCountDocuments: vi.fn(),
  mockAuditCreate: vi.fn(),
  mockHashes: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  Quest: {
    // Mirrors the Mongoose query the util builds: updateMany(...).setOptions(...) is what gets awaited.
    updateMany: (...a: unknown[]) => ({ setOptions: (opts: unknown) => mockUpdateMany(...a, opts) }),
    countDocuments: (...a: unknown[]) => mockCountDocuments(...a),
  },
  TelemetryAuditLogModel: { create: (...a: unknown[]) => mockAuditCreate(...a) },
}));

vi.mock('@bike4mind/server-utils/utils/ip', () => ({
  getClientIp: () => '127.0.0.1',
  truncateIp: (ip: string) => ip,
}));

vi.mock('./telemetryHashLookup', () => ({ regenerateUserTelemetryHashes: (...a: unknown[]) => mockHashes(...a) }));

import { triggerTelemetryDeletion } from './telemetryDeletion';

const FILTER = { 'promptMeta.contextTelemetry.anonymousSessionId.hash': { $in: ['hash-a', 'hash-b'] } };
const req = { headers: { 'user-agent': 'vitest' } };

const lastAuditRow = () => mockAuditCreate.mock.calls.at(-1)?.[0];

beforeEach(() => {
  mockHashes.mockReset().mockResolvedValue(['hash-a', 'hash-b']);
  mockUpdateMany.mockReset().mockResolvedValue({ modifiedCount: 3 });
  mockCountDocuments.mockReset().mockResolvedValue(0);
  mockAuditCreate.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('triggerTelemetryDeletion', () => {
  it('reports a verified deletion when the re-check finds nothing left', async () => {
    const result = await triggerTelemetryDeletion('user-1', req);

    expect(result).toEqual({ verified: true, deletedCount: 3, remainingCount: 0 });
    expect(mockUpdateMany).toHaveBeenCalledWith(
      FILTER,
      { $unset: { 'promptMeta.contextTelemetry': '' } },
      { includeDeleted: true }
    );
    // The re-check counts with the very filter the unset used.
    expect(mockCountDocuments).toHaveBeenCalledWith(FILTER);
    expect(lastAuditRow()).toMatchObject({
      action: 'delete',
      userId: 'user-1',
      questId: 'bulk-opt-out',
      outcome: 'success',
      metadata: { deletedCount: 3, verified: true, remainingCount: 0, reason: 'user_opt_out' },
    });
    expect(lastAuditRow().metadata).not.toHaveProperty('error');
  });

  it('reports an unverified deletion when the re-check still finds documents', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });
    mockCountDocuments.mockResolvedValue(2);

    const result = await triggerTelemetryDeletion('user-1', req);

    expect(result).toEqual({ verified: false, deletedCount: 1, remainingCount: 2 });
    expect(lastAuditRow()).toMatchObject({
      outcome: 'failure',
      metadata: { deletedCount: 1, verified: false, remainingCount: 2, reason: 'user_opt_out' },
    });
  });

  it('resolves unverified, without a remaining count, when the delete throws', async () => {
    mockUpdateMany.mockRejectedValue(new Error('write failed'));

    const result = await triggerTelemetryDeletion('user-1', req);

    expect(result).toEqual({ verified: false, deletedCount: 0 });
    expect(mockCountDocuments).not.toHaveBeenCalled();
    expect(lastAuditRow()).toMatchObject({
      outcome: 'failure',
      metadata: { deletedCount: 0, verified: false, error: 'write failed', reason: 'user_opt_out' },
    });
    expect(lastAuditRow().metadata).not.toHaveProperty('remainingCount');
  });

  it('resolves unverified when the re-check itself throws after a successful delete', async () => {
    mockCountDocuments.mockRejectedValue(new Error('count failed'));

    const result = await triggerTelemetryDeletion('user-1', req);

    expect(result).toEqual({ verified: false, deletedCount: 3 });
    expect(lastAuditRow()).toMatchObject({
      outcome: 'failure',
      metadata: { deletedCount: 3, verified: false, error: 'count failed' },
    });
  });

  it('resolves unverified when the hash lookup throws, before any write', async () => {
    mockHashes.mockRejectedValue(new Error('lookup failed'));

    const result = await triggerTelemetryDeletion('user-1', req);

    expect(result).toEqual({ verified: false, deletedCount: 0 });
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(lastAuditRow()).toMatchObject({ outcome: 'failure', metadata: { error: 'lookup failed' } });
  });

  it('still returns the outcome when the audit write fails', async () => {
    mockAuditCreate.mockRejectedValue(new Error('audit down'));

    await expect(triggerTelemetryDeletion('user-1', req)).resolves.toEqual({
      verified: true,
      deletedCount: 3,
      remainingCount: 0,
    });
  });
});
