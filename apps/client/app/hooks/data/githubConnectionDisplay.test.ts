import { describe, it, expect } from 'vitest';
import type { GitHubLakeConnectionStatus } from '@bike4mind/common';
import { describeGitHubConnection } from './githubConnectionDisplay';

const conn = (over: Partial<Parameters<typeof describeGitHubConnection>[0]> = {}) => ({
  status: 'connected' as const,
  enabled: true,
  lastError: null,
  repositoryFullName: 'acme/docs',
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

  it('reads an archived lake as paused', () => {
    expect(describeGitHubConnection(conn({ enabled: false }))).toMatchObject({ label: 'Paused', color: 'neutral' });
  });

  it('attributes a lastError to the previous run while a sync is in flight', () => {
    expect(describeGitHubConnection(conn({ status: 'syncing', lastError: 'Rate limited.' }))).toMatchObject({
      label: 'Syncing',
      color: 'primary',
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
