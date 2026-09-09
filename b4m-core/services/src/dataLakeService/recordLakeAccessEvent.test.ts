import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RecordLakeAccessEventInput } from '@bike4mind/common';

const { mockResolveRetention } = vi.hoisted(() => ({ mockResolveRetention: vi.fn() }));
// resolveLakeAuditRetention has its own test suite covering settings resolution/caching/fallback;
// this file only needs to prove recordLakeAccessEvent calls it and threads the result through.
vi.mock('./resolveLakeAuditRetention', () => ({ resolveLakeAuditRetention: mockResolveRetention }));

import { recordLakeAccessEvent } from './recordLakeAccessEvent';

const INPUT: RecordLakeAccessEventInput = {
  principalKind: 'user',
  principalId: 'user-1',
  resolvedLakeIds: ['lake1'],
  surface: 'data-lake-semantic-search',
};

const ADMIN_SETTINGS = { findBySettingNames: vi.fn(), findAll: vi.fn() };

describe('recordLakeAccessEvent', () => {
  beforeEach(() => {
    mockResolveRetention.mockReset().mockResolvedValue({ auditRetentionDays: 450, queryTextRetentionDays: 30 });
  });

  it('is a no-op when no recorder was wired in, resolving immediately', async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    await expect(recordLakeAccessEvent(undefined, INPUT, logger, ADMIN_SETTINGS)).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
    expect(mockResolveRetention).not.toHaveBeenCalled();
  });

  // A serverless route handler awaits this so the write survives a post-response freeze; a
  // long-lived chat/tool turn fires it without awaiting so the write adds no response latency.
  // Both usages must be safe - the promise must never reject either way.
  it('resolves to undefined (never rejects) so both an awaiting and a fire-and-forget caller are safe', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const logger = { error: vi.fn(), warn: vi.fn() };

    const result = recordLakeAccessEvent({ record }, INPUT, logger, ADMIN_SETTINGS);

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it('resolves retention via resolveLakeAuditRetention and threads both values into record()', async () => {
    mockResolveRetention.mockResolvedValue({ auditRetentionDays: 90, queryTextRetentionDays: 14 });
    const record = vi.fn().mockResolvedValue(undefined);
    const logger = { error: vi.fn(), warn: vi.fn() };

    await recordLakeAccessEvent({ record }, INPUT, logger, ADMIN_SETTINGS);

    expect(mockResolveRetention).toHaveBeenCalledWith({ adminSettings: ADMIN_SETTINGS }, { logger });
    expect(record).toHaveBeenCalledWith({ ...INPUT, retentionDays: 90, queryTextRetentionDays: 14 });
  });

  it('logs and swallows a thrown/rejected record() instead of propagating it', async () => {
    const err = new Error('mongo blip');
    const record = vi.fn().mockRejectedValue(err);
    const logger = { error: vi.fn(), warn: vi.fn() };

    await expect(recordLakeAccessEvent({ record }, INPUT, logger, ADMIN_SETTINGS)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith('[lakeAccessAudit] failed to record access event', err);
  });
});
