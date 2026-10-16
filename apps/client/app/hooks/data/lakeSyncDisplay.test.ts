import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { describeDriveLastSync, describeGitHubLastSync } from './lakeSyncDisplay';

const now = new Date('2026-01-01T12:00:00Z');
const fiveMinAgo = new Date(now.getTime() - 5 * 60_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers().setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe('lakeSyncDisplay', () => {
  it('reads a clean Drive run as a sync', () => {
    expect(describeDriveLastSync({ lastPolledAt: fiveMinAgo, lastError: null })).toBe('Last synced 5 minutes ago');
  });

  it('reads a Drive run with an error as an attempt', () => {
    expect(describeDriveLastSync({ lastPolledAt: fiveMinAgo, lastError: 'boom' })).toBe(
      'Last sync attempt 5 minutes ago'
    );
  });

  it('says not synced yet when there is no time', () => {
    expect(describeDriveLastSync({ lastPolledAt: null, lastError: null })).toBe('Not synced yet');
    expect(describeGitHubLastSync({ lastSyncedAt: null })).toBe('Not synced yet');
  });

  it('reads a GitHub sync time', () => {
    expect(describeGitHubLastSync({ lastSyncedAt: fiveMinAgo })).toBe('Last synced 5 minutes ago');
  });
});
