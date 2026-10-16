import { describe, it, expect, vi, afterEach } from 'vitest';
import { describeDriveLastSync, describeGitHubLastSync } from './lakeSyncDisplay';

const now = new Date('2026-01-01T12:00:00Z');
const fiveMinAgo = new Date(now.getTime() - 5 * 60_000).toISOString();

afterEach(() => vi.useRealTimers());

describe('lakeSyncDisplay', () => {
  it('reads a clean Drive run as a sync', () => {
    vi.useFakeTimers().setSystemTime(now);
    expect(describeDriveLastSync({ lastPolledAt: fiveMinAgo, lastError: null })).toMatch(/^Last synced \S/);
  });

  it('reads a Drive run with an error as an attempt', () => {
    expect(describeDriveLastSync({ lastPolledAt: fiveMinAgo, lastError: 'boom' })).toMatch(/^Last sync attempt \S/);
  });

  it('says not synced yet when there is no time', () => {
    expect(describeDriveLastSync({ lastPolledAt: null, lastError: null })).toBe('Not synced yet');
    expect(describeGitHubLastSync({ lastSyncedAt: null })).toBe('Not synced yet');
  });

  it('reads a GitHub sync time', () => {
    expect(describeGitHubLastSync({ lastSyncedAt: fiveMinAgo })).toMatch(/^Last synced \S/);
  });
});
