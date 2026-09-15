import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks
const { mockForSystem, mockListMergedPRs, mockListCommits, mockGetFileContent, mockLogger } = vi.hoisted(() => {
  const mockListMergedPRs = vi.fn();
  const mockListCommits = vi.fn();
  const mockGetFileContent = vi.fn();
  const mockForSystem = vi.fn();

  const mockLogger: Record<string, ReturnType<typeof vi.fn>> = {
    info: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    updateMetadata: vi.fn(),
  };

  return { mockForSystem, mockListMergedPRs, mockListCommits, mockGetFileContent, mockLogger };
});

vi.mock('@server/services/githubService', () => ({
  GitHubService: {
    forSystem: mockForSystem,
  },
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(() => mockLogger),
}));

import { collectDataForDate } from './whatsNewDataCollector';
import type { Logger } from '@bike4mind/observability';

function makeGitHubService() {
  return {
    listMergedPullRequests: mockListMergedPRs,
    listCommits: mockListCommits,
    getFileContent: mockGetFileContent,
  };
}

function makePR(overrides: { number: number; title: string; merged_at: string; body?: string | null }) {
  return {
    number: overrides.number,
    title: overrides.title,
    body: overrides.body ?? null,
    state: 'closed',
    html_url: `https://github.com/MillionOnMars/lumina5/pull/${overrides.number}`,
    merged_at: overrides.merged_at,
    created_at: overrides.merged_at,
    updated_at: overrides.merged_at,
    user: { login: 'testuser' },
    labels: [],
  };
}

function makeCommit(overrides: { sha: string; message: string; date: string }) {
  return {
    sha: overrides.sha,
    message: overrides.message,
    author: 'testuser',
    date: overrides.date,
  };
}

describe('whatsNewDataCollector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockForSystem.mockResolvedValue(makeGitHubService());
    mockListMergedPRs.mockResolvedValue([]);
    mockListCommits.mockResolvedValue([]);
    mockGetFileContent.mockResolvedValue(null);
  });

  describe('collectDataForDate', () => {
    it('returns null when GitHubService is unavailable', async () => {
      mockForSystem.mockResolvedValue(null);

      const result = await collectDataForDate('2025-03-01', mockLogger as unknown as Logger);

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('GitHubService.forSystem() returned null'));
    });

    it('returns empty payload with zero filteredPRCount when no PRs found', async () => {
      mockListMergedPRs.mockResolvedValue([]);

      const result = await collectDataForDate('2025-03-01', mockLogger as unknown as Logger);

      expect(result).not.toBeNull();
      expect(result!.filteredPRCount).toBe(0);
      expect(result!.rawPRCount).toBe(0);
      expect(result!.payload.pullRequests).toEqual([]);
    });

    it('collects PRs and commits from the previous day', async () => {
      // targetDate is 2025-03-02 (publication date)
      // PRs should be from 2025-03-01 (the previous day)
      const targetDate = '2025-03-02';
      mockListMergedPRs.mockResolvedValue([
        makePR({ number: 100, title: 'feat: add cool feature', merged_at: '2025-03-01T14:00:00Z' }),
        makePR({ number: 101, title: 'fix: resolve bug', merged_at: '2025-03-01T16:00:00Z' }),
      ]);
      mockListCommits.mockResolvedValue([
        makeCommit({ sha: 'abc1234', message: 'feat: add cool feature (#100)', date: '2025-03-01T14:00:00Z' }),
        makeCommit({ sha: 'def5678', message: 'fix: resolve bug (#101)', date: '2025-03-01T16:00:00Z' }),
      ]);

      const result = await collectDataForDate(targetDate, mockLogger as unknown as Logger);

      expect(result).not.toBeNull();
      expect(result!.filteredPRCount).toBe(2);
      expect(result!.commitCount).toBe(2);
      expect(result!.payload.pullRequests).toHaveLength(2);
      expect(result!.payload.commits).toHaveLength(2);
      expect(result!.payload.generatedDate).toBe(targetDate);
    });

    it('filters PRs outside the previous day boundary', async () => {
      // targetDate is 2025-03-02, so collection window is 2025-03-01 00:00Z to 2025-03-02 00:00Z (exclusive)
      mockListMergedPRs.mockResolvedValue([
        // Previous day (2025-03-01) - should be included
        makePR({ number: 100, title: 'feat: yesterday', merged_at: '2025-03-01T12:00:00Z' }),
        // Two days ago - should be excluded
        makePR({ number: 99, title: 'feat: two days ago', merged_at: '2025-02-28T23:00:00Z' }),
        // Same day as targetDate - should be excluded
        makePR({ number: 101, title: 'feat: today', merged_at: '2025-03-02T01:00:00Z' }),
      ]);

      const result = await collectDataForDate('2025-03-02', mockLogger as unknown as Logger);

      expect(result!.rawPRCount).toBe(1);
      expect(result!.filteredPRCount).toBe(1);
      expect(result!.payload.pullRequests[0].title).toBe('feat: yesterday');
    });

    it('excludes PRs merged at exactly midnight (exclusive upper bound)', async () => {
      // targetDate is 2025-03-02, window is 2025-03-01 00:00Z to 2025-03-02 00:00Z (exclusive)
      mockListMergedPRs.mockResolvedValue([
        // Exactly at midnight boundary - should be excluded (exclusive upper bound)
        makePR({ number: 100, title: 'feat: midnight PR', merged_at: '2025-03-02T00:00:00Z' }),
        // Just before midnight - should be included
        makePR({ number: 101, title: 'feat: late night PR', merged_at: '2025-03-01T23:59:59Z' }),
      ]);
      mockListCommits.mockResolvedValue([]);

      const result = await collectDataForDate('2025-03-02', mockLogger as unknown as Logger);

      expect(result!.rawPRCount).toBe(1);
      expect(result!.filteredPRCount).toBe(1);
      expect(result!.payload.pullRequests[0].title).toBe('feat: late night PR');
    });

    it('handles month boundary correctly', async () => {
      // targetDate is 2026-01-01, should collect PRs from 2025-12-31
      mockListMergedPRs.mockResolvedValue([
        makePR({ number: 100, title: 'feat: new years eve', merged_at: '2025-12-31T14:00:00Z' }),
      ]);
      mockListCommits.mockResolvedValue([
        makeCommit({ sha: 'abc1234', message: 'feat: new years eve (#100)', date: '2025-12-31T14:00:00Z' }),
      ]);

      const result = await collectDataForDate('2026-01-01', mockLogger as unknown as Logger);

      expect(result).not.toBeNull();
      expect(result!.filteredPRCount).toBe(1);
      expect(result!.commitCount).toBe(1);
      expect(result!.payload.generatedDate).toBe('2026-01-01');
      expect(result!.payload.pullRequests[0].title).toBe('feat: new years eve');
    });

    describe('noise filtering', () => {
      const noiseExamples = [
        'Merge branch main into feature',
        'Merge pull request #123 from user/branch',
        'chore(deps): bump typescript from 5.0.0 to 5.1.0',
        'bump lodash from 4.17.20 to 4.17.21',
        'fix typo in readme',
        'docs: update API documentation',
        'doc: add changelog entry',
        'style: format code',
        'ci: update workflow',
        'test: add unit tests',
        'chore: clean up old files',
        'chore: format code',
        'chore: lint fixes',
        'revert: undo last commit',
      ];

      // PRs merged on 2025-02-28 (day before targetDate 2025-03-01)
      it.each(noiseExamples)('filters out noise PR: "%s"', async title => {
        mockListMergedPRs.mockResolvedValue([makePR({ number: 1, title, merged_at: '2025-02-28T12:00:00Z' })]);

        const result = await collectDataForDate('2025-03-01', mockLogger as unknown as Logger);

        expect(result!.filteredPRCount).toBe(0);
      });

      const keepExamples = [
        'feat: add new chat feature',
        'fix: resolve login bug',
        'feat(agent): improve MCP tool calling',
        'refactor: simplify quest routing',
        'perf: optimize database queries',
      ];

      it.each(keepExamples)('keeps user-facing PR: "%s"', async title => {
        mockListMergedPRs.mockResolvedValue([makePR({ number: 1, title, merged_at: '2025-02-28T12:00:00Z' })]);
        mockListCommits.mockResolvedValue([]);

        const result = await collectDataForDate('2025-03-01', mockLogger as unknown as Logger);

        expect(result!.filteredPRCount).toBe(1);
      });
    });

    it('extracts CHANGELOG excerpt from first section', async () => {
      mockListMergedPRs.mockResolvedValue([
        makePR({ number: 1, title: 'feat: something', merged_at: '2025-02-28T12:00:00Z' }),
      ]);
      mockListCommits.mockResolvedValue([]);
      mockGetFileContent.mockResolvedValue(
        '# Changelog\n## v1.2.0\n- Added feature X\n- Fixed bug Y\n## v1.1.0\n- Old stuff'
      );

      const result = await collectDataForDate('2025-03-01', mockLogger as unknown as Logger);

      expect(result!.payload.changelogExcerpt).toContain('v1.2.0');
      expect(result!.payload.changelogExcerpt).toContain('Added feature X');
      expect(result!.payload.changelogExcerpt).not.toContain('v1.1.0');
    });

    it('gracefully handles CHANGELOG fetch failure', async () => {
      mockListMergedPRs.mockResolvedValue([
        makePR({ number: 1, title: 'feat: something', merged_at: '2025-02-28T12:00:00Z' }),
      ]);
      mockListCommits.mockResolvedValue([]);
      mockGetFileContent.mockRejectedValue(new Error('Not found'));

      const result = await collectDataForDate('2025-03-01', mockLogger as unknown as Logger);

      expect(result).not.toBeNull();
      expect(result!.payload.changelogExcerpt).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch CHANGELOG'),
        expect.anything()
      );
    });

    it('accepts custom repository and branch options', async () => {
      mockListMergedPRs.mockResolvedValue([]);

      await collectDataForDate('2025-03-01', mockLogger as unknown as Logger, {
        repository: 'MyOrg/other-repo',
        targetBranch: 'main',
      });

      expect(mockListMergedPRs).toHaveBeenCalledWith('MyOrg/other-repo', expect.objectContaining({ base: 'main' }));
    });

    it('does not fetch commits when all PRs are noise', async () => {
      mockListMergedPRs.mockResolvedValue([
        makePR({ number: 1, title: 'chore(deps): bump lodash', merged_at: '2025-02-28T12:00:00Z' }),
        makePR({ number: 2, title: 'ci: update workflow', merged_at: '2025-02-28T13:00:00Z' }),
      ]);

      const result = await collectDataForDate('2025-03-01', mockLogger as unknown as Logger);

      expect(result!.filteredPRCount).toBe(0);
      expect(mockListCommits).not.toHaveBeenCalled();
    });
  });
});
