import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findByInstallationId: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  orgGitHubLakeConnectionRepository: { findByInstallationId: h.findByInstallationId },
}));

import {
  findRevokedConnectionIds,
  isGitHubLakeRevocationEvent,
  parseGitHubLakeRevocation,
} from './githubLakeRevocation';

describe('isGitHubLakeRevocationEvent', () => {
  it('accepts only the installation event types', () => {
    expect(isGitHubLakeRevocationEvent('installation')).toBe(true);
    expect(isGitHubLakeRevocationEvent('installation_repositories')).toBe(true);
    expect(isGitHubLakeRevocationEvent('push')).toBe(false);
    expect(isGitHubLakeRevocationEvent(undefined)).toBe(false);
  });
});

describe('parseGitHubLakeRevocation', () => {
  it('ignores an event type it does not act on', () => {
    expect(parseGitHubLakeRevocation('push', { some: 'payload' })).toBeNull();
  });

  it('ignores an installation action other than deleted', () => {
    expect(parseGitHubLakeRevocation('installation', { action: 'suspend', installation: { id: 42 } })).toBeNull();
  });

  it('targets the whole installation on installation.deleted', () => {
    expect(parseGitHubLakeRevocation('installation', { action: 'deleted', installation: { id: 42 } })).toEqual({
      installationId: 42,
      repositoryIds: null,
    });
  });

  it('targets only the removed repositories on installation_repositories.removed', () => {
    expect(
      parseGitHubLakeRevocation('installation_repositories', {
        action: 'removed',
        installation: { id: 42 },
        repositories_removed: [{ id: 100 }],
      })
    ).toEqual({ installationId: 42, repositoryIds: new Set([100]) });
  });

  it('flags a removed delivery with no repositories_removed field as malformed', () => {
    expect(
      parseGitHubLakeRevocation('installation_repositories', { action: 'removed', installation: { id: 42 } })
    ).toHaveProperty('malformed');
  });

  it('flags a removed delivery with an empty repositories_removed list as malformed', () => {
    expect(
      parseGitHubLakeRevocation('installation_repositories', {
        action: 'removed',
        installation: { id: 42 },
        repositories_removed: [],
      })
    ).toHaveProperty('malformed');
  });

  it('ignores installation_repositories.added, touching no repository', () => {
    expect(
      parseGitHubLakeRevocation('installation_repositories', {
        action: 'added',
        installation: { id: 42 },
        repositories_added: [{ id: 100 }],
      })
    ).toBeNull();
  });

  it('flags a payload missing installation.id as malformed', () => {
    expect(parseGitHubLakeRevocation('installation', { action: 'deleted' })).toHaveProperty('malformed');
  });
});

describe('findRevokedConnectionIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns every binding of the installation for a whole-installation revoke', async () => {
    h.findByInstallationId.mockResolvedValue([{ id: 'conn1' }, { id: 'conn2' }]);
    await expect(findRevokedConnectionIds({ installationId: 42, repositoryIds: null })).resolves.toEqual([
      'conn1',
      'conn2',
    ]);
    expect(h.findByInstallationId).toHaveBeenCalledWith(42);
  });

  it('returns only the bindings of the removed repositories', async () => {
    h.findByInstallationId.mockResolvedValue([
      { id: 'conn1', repositoryId: 100 },
      { id: 'conn2', repositoryId: 200 },
    ]);
    await expect(findRevokedConnectionIds({ installationId: 42, repositoryIds: new Set([100]) })).resolves.toEqual([
      'conn1',
    ]);
  });

  it('returns an empty list when the removed repository matches no binding', async () => {
    h.findByInstallationId.mockResolvedValue([{ id: 'conn1', repositoryId: 999 }]);
    await expect(findRevokedConnectionIds({ installationId: 42, repositoryIds: new Set([100]) })).resolves.toEqual([]);
  });
});
