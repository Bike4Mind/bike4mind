import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getCommitRange } from './githubApi';

const commit = (n: number) => ({
  sha: `s${n}`,
  commit: { message: `m${n}`, author: { name: 'a', email: 'a@example.com', date: '2026-01-01' } },
});

describe('getCommitRange', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv('GITHUB_REPOSITORY', 'acme/repo');
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('follows compare pagination past the 250-commit unpaginated cap', async () => {
    const all = Array.from({ length: 260 }, (_, i) => commit(i));
    fetchMock.mockImplementation(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      const commits = all.slice((page - 1) * 100, page * 100);
      return { ok: true, json: async () => ({ total_commits: all.length, commits }) };
    });

    const result = await getCommitRange('v1', 'v2');

    expect(result).toHaveLength(260);
    expect(result[259].sha).toBe('s259');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toContain('/compare/v1...v2?per_page=100&page=1');
  });

  it('stops on a short page when total_commits is missing', async () => {
    const all = Array.from({ length: 150 }, (_, i) => commit(i));
    fetchMock.mockImplementation(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return { ok: true, json: async () => ({ commits: all.slice((page - 1) * 100, page * 100) }) };
    });

    const result = await getCommitRange('v1', 'v2');

    expect(result).toHaveLength(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
