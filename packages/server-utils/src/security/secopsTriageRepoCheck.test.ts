import { describe, expect, it, vi } from 'vitest';
import type { GitHubRepository } from '../services/githubService';
import { checkSecopsTriageRepo } from './secopsTriageRepoCheck';

const repository = (overrides: Partial<GitHubRepository> = {}): GitHubRepository => ({
  id: 1,
  name: 'test-repo',
  full_name: 'test-org/test-repo',
  private: true,
  html_url: 'https://github.com/test-org/test-repo',
  description: null,
  archived: false,
  has_issues: true,
  ...overrides,
});

const github = (allowed: boolean, getRepository: () => Promise<GitHubRepository | null>) => ({
  isRepositoryAllowed: vi.fn(() => allowed),
  getRepository: vi.fn(getRepository),
});

describe('checkSecopsTriageRepo', () => {
  it('is ok for an allowed, active repository with issues enabled', async () => {
    const service = github(true, async () => repository());

    expect(await checkSecopsTriageRepo(service, 'test-org/test-repo')).toEqual({ ok: true });
    expect(service.getRepository).toHaveBeenCalledWith('test-org/test-repo');
  });

  it.each(['', 'test-repo', 'test-org/', '/test-repo', 'test-org/test-repo/extra', 'test org/test-repo'])(
    'reports %j as not configured without calling GitHub',
    async repo => {
      const service = github(true, async () => repository());

      expect(await checkSecopsTriageRepo(service, repo)).toEqual({ ok: false, reason: 'not_configured' });
      expect(service.isRepositoryAllowed).not.toHaveBeenCalled();
      expect(service.getRepository).not.toHaveBeenCalled();
    }
  );

  it('reports a repository outside the connection allowlist as not allowed', async () => {
    const service = github(false, async () => repository());

    expect(await checkSecopsTriageRepo(service, 'test-org/test-repo')).toEqual({ ok: false, reason: 'not_allowed' });
    expect(service.getRepository).not.toHaveBeenCalled();
  });

  it('reports a repository GitHub does not return as not found', async () => {
    const service = github(true, async () => null);

    expect(await checkSecopsTriageRepo(service, 'test-org/test-repo')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports a public repository', async () => {
    const service = github(true, async () => repository({ private: false }));

    expect(await checkSecopsTriageRepo(service, 'test-org/test-repo')).toEqual({ ok: false, reason: 'public' });
  });

  it('reports an archived repository', async () => {
    const service = github(true, async () => repository({ archived: true }));

    expect(await checkSecopsTriageRepo(service, 'test-org/test-repo')).toEqual({ ok: false, reason: 'archived' });
  });

  it('reports a repository with issues turned off', async () => {
    const service = github(true, async () => repository({ has_issues: false }));

    expect(await checkSecopsTriageRepo(service, 'test-org/test-repo')).toEqual({
      ok: false,
      reason: 'issues_disabled',
    });
  });

  it('treats missing archived and has_issues flags as writable', async () => {
    const service = github(true, async () => repository({ archived: undefined, has_issues: undefined }));

    expect(await checkSecopsTriageRepo(service, 'test-org/test-repo')).toEqual({ ok: true });
  });

  it('lets a failed GitHub lookup propagate', async () => {
    const service = github(true, async () => {
      throw new Error('GitHub unavailable');
    });

    await expect(checkSecopsTriageRepo(service, 'test-org/test-repo')).rejects.toThrow('GitHub unavailable');
  });
});
