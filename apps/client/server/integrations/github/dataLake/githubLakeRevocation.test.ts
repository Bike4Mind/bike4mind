import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findByInstallationId: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  orgGitHubLakeConnectionRepository: { findByInstallationId: h.findByInstallationId },
}));

import { resolveGitHubLakeRevocation } from './githubLakeRevocation';

describe('resolveGitHubLakeRevocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores an event type it does not act on', async () => {
    await expect(resolveGitHubLakeRevocation('push', { some: 'payload' })).resolves.toBeNull();
    expect(h.findByInstallationId).not.toHaveBeenCalled();
  });

  it('ignores an installation action other than deleted', async () => {
    await expect(
      resolveGitHubLakeRevocation('installation', { action: 'suspend', installation: { id: 42 } })
    ).resolves.toBeNull();
    expect(h.findByInstallationId).not.toHaveBeenCalled();
  });

  it('revokes every binding of the installation on installation.deleted', async () => {
    h.findByInstallationId.mockResolvedValue([{ id: 'conn1' }, { id: 'conn2' }]);
    await expect(
      resolveGitHubLakeRevocation('installation', { action: 'deleted', installation: { id: 42 } })
    ).resolves.toEqual({ installationId: 42, connectionIds: ['conn1', 'conn2'] });
    expect(h.findByInstallationId).toHaveBeenCalledWith(42);
  });

  it('revokes only the bindings of the removed repositories on installation_repositories.removed', async () => {
    h.findByInstallationId.mockResolvedValue([
      { id: 'conn1', repositoryId: 100 },
      { id: 'conn2', repositoryId: 200 },
    ]);
    await expect(
      resolveGitHubLakeRevocation('installation_repositories', {
        action: 'removed',
        installation: { id: 42 },
        repositories_removed: [{ id: 100 }],
      })
    ).resolves.toEqual({ installationId: 42, connectionIds: ['conn1'] });
  });

  it('flags a removed delivery with no repositories_removed field as malformed', async () => {
    const result = await resolveGitHubLakeRevocation('installation_repositories', {
      action: 'removed',
      installation: { id: 42 },
    });
    expect(result).toHaveProperty('malformed');
    expect(h.findByInstallationId).not.toHaveBeenCalled();
  });

  it('flags a removed delivery with an empty repositories_removed list as malformed', async () => {
    const result = await resolveGitHubLakeRevocation('installation_repositories', {
      action: 'removed',
      installation: { id: 42 },
      repositories_removed: [],
    });
    expect(result).toHaveProperty('malformed');
    expect(h.findByInstallationId).not.toHaveBeenCalled();
  });

  it('resolves an empty connectionIds list when the removed repository matches no binding', async () => {
    h.findByInstallationId.mockResolvedValue([{ id: 'conn1', repositoryId: 999 }]);
    await expect(
      resolveGitHubLakeRevocation('installation_repositories', {
        action: 'removed',
        installation: { id: 42 },
        repositories_removed: [{ id: 100 }],
      })
    ).resolves.toEqual({ installationId: 42, connectionIds: [] });
  });

  it('ignores installation_repositories.added, touching no repository', async () => {
    await expect(
      resolveGitHubLakeRevocation('installation_repositories', {
        action: 'added',
        installation: { id: 42 },
        repositories_added: [{ id: 100 }],
      })
    ).resolves.toBeNull();
    expect(h.findByInstallationId).not.toHaveBeenCalled();
  });

  it('flags a payload missing installation.id as malformed', async () => {
    const result = await resolveGitHubLakeRevocation('installation', { action: 'deleted' });
    expect(result).toHaveProperty('malformed');
    expect(h.findByInstallationId).not.toHaveBeenCalled();
  });
});
