import { describe, it, expect } from 'vitest';
import type { GitHubLakeConnectionStatus } from '@bike4mind/common';
import { describeGitHubConnection, describeGitHubSyncProgress } from './githubConnectionDisplay';

const conn = (over: Partial<Parameters<typeof describeGitHubConnection>[0]> = {}) => ({
  status: 'connected' as const,
  enabled: true,
  lastError: null,
  repositoryFullName: 'acme/docs',
  syncStale: false,
  disconnecting: false,
  ...over,
});

describe('describeGitHubConnection', () => {
  it('reads a clean connected sync as healthy', () => {
    expect(describeGitHubConnection(conn())).toEqual({
      label: 'Connected',
      title: 'Syncing the GitHub repository acme/docs',
      color: 'success',
    });
  });

  // A sync that stopped short heals back to 'connected', so lastError is all that separates it.
  it('does NOT read a connected connection carrying a lastError as healthy', () => {
    const { label, title, color } = describeGitHubConnection(conn({ lastError: 'Rate limited.' }));
    expect(label).toBe('Stopped short');
    expect(title).toBe('GitHub repository acme/docs: last sync stopped short - Rate limited.');
    expect(color).toBe('warning');
  });

  it('offers a retry before a reconnect on error, since an errored connection stays re-syncable', () => {
    const { label, title, color } = describeGitHubConnection(conn({ status: 'error', lastError: 'Not Found' }));
    expect(label).toBe('Sync failed');
    expect(title).toBe(
      'GitHub repository acme/docs: sync failed - Not Found. Re-sync to retry, or reconnect if access was removed.'
    );
    expect(color).toBe('danger');
  });

  it('reads an archived lake whose last sync failed as paused, not as re-syncable', () => {
    expect(describeGitHubConnection(conn({ enabled: false, status: 'error' }))).toMatchObject({ label: 'Paused' });
  });

  it('reads an archived lake as paused', () => {
    expect(describeGitHubConnection(conn({ enabled: false }))).toMatchObject({ label: 'Paused', color: 'neutral' });
  });

  // A pending disconnect also disables the row, so it must be read before the Paused branch.
  it('reads a disconnecting connection as Disconnecting even though it is also disabled', () => {
    const { label, title, color } = describeGitHubConnection(conn({ enabled: false, disconnecting: true }));
    expect(label).toBe('Disconnecting');
    expect(title).toBe('Disconnecting the GitHub repository acme/docs and removing its files');
    expect(color).toBe('warning');
  });

  it('attributes a lastError to the previous run while a sync is in flight', () => {
    expect(describeGitHubConnection(conn({ status: 'syncing', lastError: 'Rate limited.' }))).toMatchObject({
      label: 'Syncing',
      color: 'primary',
    });
  });

  it('reads a syncing connection whose claim has gone stale as stalled, not as actively syncing', () => {
    const { label, title, color } = describeGitHubConnection(conn({ status: 'syncing', syncStale: true }));
    expect(label).toBe('Sync stalled');
    expect(title).toBe('GitHub repository acme/docs: the last sync stopped responding. Re-sync to restart it.');
    expect(color).toBe('warning');
  });

  it('reads an archived lake as paused even when its stalled sync would otherwise show as stalled', () => {
    expect(describeGitHubConnection(conn({ enabled: false, status: 'syncing', syncStale: true }))).toMatchObject({
      label: 'Paused',
    });
  });

  // A server deployed ahead of this client can send a status it does not know yet.
  it('never reads an unrecognized status as healthy', () => {
    const status = 'suspended' as unknown as GitHubLakeConnectionStatus;
    expect(describeGitHubConnection(conn({ status }))).toEqual({
      label: 'Unknown',
      title: 'GitHub repository acme/docs: unrecognized status suspended',
      color: 'warning',
    });
  });
});

describe('describeGitHubSyncProgress', () => {
  const progressing = (over: Partial<Parameters<typeof describeGitHubSyncProgress>[0]> = {}) => ({
    status: 'syncing' as const,
    syncStale: false,
    fileCount: 4,
    candidateCount: 10 as number | null,
    ...over,
  });

  it('reports indexed, total and percent for a running sync', () => {
    expect(describeGitHubSyncProgress(progressing())).toEqual({ indexed: 4, total: 10, percent: 40 });
  });

  it('reports nothing when no sync is running', () => {
    expect(describeGitHubSyncProgress(progressing({ status: 'connected' }))).toBeNull();
  });

  it('reports nothing for a stalled sync, which is not making progress', () => {
    expect(describeGitHubSyncProgress(progressing({ syncStale: true }))).toBeNull();
  });

  it.each([
    ['not yet known', null],
    ['zero', 0],
  ])('has no total or percent while the candidate count is %s', (_name, candidateCount) => {
    expect(describeGitHubSyncProgress(progressing({ candidateCount }))).toEqual({
      indexed: 4,
      total: null,
      percent: null,
    });
  });

  it('rounds the percent to a whole number', () => {
    expect(describeGitHubSyncProgress(progressing({ fileCount: 1, candidateCount: 3 }))?.percent).toBe(33);
    expect(describeGitHubSyncProgress(progressing({ fileCount: 2, candidateCount: 3 }))?.percent).toBe(67);
  });

  it('caps the percent at 100 when more files are indexed than the tree admitted', () => {
    expect(describeGitHubSyncProgress(progressing({ fileCount: 12, candidateCount: 10 }))?.percent).toBe(100);
  });
});
