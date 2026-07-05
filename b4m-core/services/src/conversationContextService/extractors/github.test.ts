import { describe, it, expect } from 'vitest';
import { GitHubExtractor } from './github';

describe('GitHubExtractor', () => {
  const extractor = new GitHubExtractor();

  describe('extract', () => {
    it('extracts PR URL with owner/repo/number', () => {
      const text = 'Check out https://github.com/MillionOnMars/lumina5/pull/123';
      const result = extractor.extract(text, 'user');

      expect(result.entities).toHaveLength(2); // PR + Repo
      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'github_pr',
          entity: { owner: 'MillionOnMars', repo: 'lumina5', number: 123 },
        },
        source: 'user',
      });
      expect(result.entities[1]).toMatchObject({
        entity: {
          type: 'github_repo',
          entity: { owner: 'MillionOnMars', repo: 'lumina5' },
        },
        source: 'user',
      });
    });

    it('extracts Issue URL', () => {
      const text = 'See issue at https://github.com/owner/repo/issues/456';
      const result = extractor.extract(text, 'tool_result');

      expect(result.entities).toHaveLength(2); // Issue + Repo
      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'github_issue',
          entity: { owner: 'owner', repo: 'repo', number: 456 },
        },
        source: 'tool_result',
      });
    });

    it('extracts repo URL', () => {
      const text = 'Repository at https://github.com/acme/project';
      const result = extractor.extract(text, 'assistant');

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'github_repo',
          entity: { owner: 'acme', repo: 'project' },
        },
        source: 'assistant',
      });
    });

    it('extracts owner/repo format', () => {
      const text = 'Working on MillionOnMars/lumina5 today';
      const result = extractor.extract(text, 'user');

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'github_repo',
          entity: { owner: 'MillionOnMars', repo: 'lumina5' },
        },
        source: 'user',
      });
    });

    it('skips file paths that look like owner/repo', () => {
      const text = 'File at src/components/Button.tsx';
      const result = extractor.extract(text, 'user');

      // src/components should be skipped due to .tsx extension
      expect(result.entities).toHaveLength(0);
    });

    it('skips common false positives', () => {
      const text = 'In node_modules/package/file.js';
      const result = extractor.extract(text, 'user');

      expect(result.entities).toHaveLength(0);
    });

    it('extracts multiple entities from same text', () => {
      const text = `
        PR at https://github.com/owner/repo1/pull/1
        Issue at https://github.com/owner/repo2/issues/2
        Repo at owner/repo3
      `;
      const result = extractor.extract(text, 'user');

      // Should have: PR + repo1, Issue + repo2, repo3
      expect(result.entities.length).toBeGreaterThanOrEqual(5);
    });

    it('deduplicates repos mentioned multiple times', () => {
      const text = `
        https://github.com/owner/repo/pull/1
        https://github.com/owner/repo/pull/2
      `;
      const result = extractor.extract(text, 'user');

      // Should have 2 PRs but only 1 repo
      const repos = result.entities.filter(e => e.entity.type === 'github_repo');
      expect(repos).toHaveLength(1);
    });
  });
});
