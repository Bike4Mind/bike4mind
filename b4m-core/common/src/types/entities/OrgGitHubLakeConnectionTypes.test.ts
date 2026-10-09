import { describe, it, expect } from 'vitest';
import {
  isGitHubLakeAccessLost,
  isGitHubLakeFailureStatus,
  type GitHubLakeConnectionStatus,
} from './OrgGitHubLakeConnectionTypes';

const connection = (over: Partial<Parameters<typeof isGitHubLakeAccessLost>[0]> = {}) => ({
  status: 'access_lost' as GitHubLakeConnectionStatus,
  enabled: true,
  disconnecting: false,
  ...over,
});

describe('isGitHubLakeFailureStatus', () => {
  it.each(['error', 'access_lost'] as const)('treats %s as a state a drop must carry forward', status => {
    expect(isGitHubLakeFailureStatus(status)).toBe(true);
  });

  it.each(['connected', 'syncing', undefined] as const)('does not treat %s as a failure to preserve', status => {
    expect(isGitHubLakeFailureStatus(status)).toBe(false);
  });
});

describe('isGitHubLakeAccessLost', () => {
  it('reports access lost for a live connection the App can no longer read', () => {
    expect(isGitHubLakeAccessLost(connection())).toBe(true);
  });

  // A paused lake is not asking anyone to go and repair anything on GitHub.
  it('does not ask for a repair while the lake is archived', () => {
    expect(isGitHubLakeAccessLost(connection({ enabled: false }))).toBe(false);
  });

  it('does not ask for a repair once a disconnect is already purging the source', () => {
    expect(isGitHubLakeAccessLost(connection({ disconnecting: true }))).toBe(false);
  });

  it.each(['connected', 'syncing', 'error'] as const)('leaves %s to the ordinary status chip', status => {
    expect(isGitHubLakeAccessLost(connection({ status }))).toBe(false);
  });
});
