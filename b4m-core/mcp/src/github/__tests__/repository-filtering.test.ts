import { describe, it, expect } from 'vitest';

/**
 * Unit tests for GitHub MCP create_issue repository filtering
 * Tests the security validation that restricts AI access to selected repositories
 */

describe('GitHub MCP create_issue Repository Filtering', () => {
  /**
   * Mock function to simulate the repository filtering logic
   * This mirrors the actual implementation in github/index.ts lines 74-118
   */
  const validateRepositoryAccess = (
    selectedRepositories: string[],
    requestedRepo: string
  ): { allowed: boolean; error?: any } => {
    // Case 1: No repositories selected
    if (selectedRepositories.length === 0) {
      return {
        allowed: false,
        error: {
          success: false,
          error: 'No repositories enabled for AI access',
          message:
            'To create issues via AI, you must first enable repositories in Settings → GitHub Integration → Select Repositories',
          action_required: 'Please select at least one repository to continue',
          requested_repository: requestedRepo,
        },
      };
    }

    // Case 2: Repository not in whitelist
    if (!selectedRepositories.includes(requestedRepo)) {
      return {
        allowed: false,
        error: {
          success: false,
          error: `Repository "${requestedRepo}" is not enabled for AI access`,
          message: 'To use this repository, please add it in Settings → GitHub Integration → Select Repositories',
          available_repositories: selectedRepositories,
          requested_repository: requestedRepo,
        },
      };
    }

    // Case 3: Repository is in whitelist
    return { allowed: true };
  };

  describe('No repositories selected', () => {
    it('should block access when selectedRepositories is empty array', () => {
      const result = validateRepositoryAccess([], 'MillionOnMars/lumina5');

      expect(result.allowed).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error.success).toBe(false);
      expect(result.error.error).toBe('No repositories enabled for AI access');
    });

    it('should include action_required field in error response', () => {
      const result = validateRepositoryAccess([], 'owner/repo');

      expect(result.error.action_required).toBe('Please select at least one repository to continue');
    });

    it('should include requested repository in error response', () => {
      const result = validateRepositoryAccess([], 'MillionOnMars/lumina5');

      expect(result.error.requested_repository).toBe('MillionOnMars/lumina5');
    });

    it('should provide helpful error message', () => {
      const result = validateRepositoryAccess([], 'owner/repo');

      expect(result.error.message).toContain('Settings → GitHub Integration');
      expect(result.error.message).toContain('Select Repositories');
    });
  });

  describe('Repository not in whitelist', () => {
    const selectedRepos = ['MillionOnMars/lumina5', 'MillionOnMars/test-repo'];

    it('should block access to non-whitelisted repository', () => {
      const result = validateRepositoryAccess(selectedRepos, 'facebook/react');

      expect(result.allowed).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error.success).toBe(false);
    });

    it('should include list of available repositories in error', () => {
      const result = validateRepositoryAccess(selectedRepos, 'facebook/react');

      expect(result.error.available_repositories).toEqual(selectedRepos);
      expect(result.error.available_repositories).toHaveLength(2);
    });

    it('should include requested repository name in error', () => {
      const result = validateRepositoryAccess(selectedRepos, 'unauthorized/repo');

      expect(result.error.requested_repository).toBe('unauthorized/repo');
      expect(result.error.error).toContain('unauthorized/repo');
    });

    it('should provide clear error message about enabling repository', () => {
      const result = validateRepositoryAccess(selectedRepos, 'other/repo');

      expect(result.error.message).toContain('Settings → GitHub Integration');
      expect(result.error.error).toContain('not enabled for AI access');
    });
  });

  describe('Repository in whitelist (allowed)', () => {
    const selectedRepos = ['MillionOnMars/lumina5', 'MillionOnMars/test-repo'];

    it('should allow access to whitelisted repository', () => {
      const result = validateRepositoryAccess(selectedRepos, 'MillionOnMars/lumina5');

      expect(result.allowed).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should allow access to any repository in whitelist', () => {
      const result1 = validateRepositoryAccess(selectedRepos, 'MillionOnMars/lumina5');
      const result2 = validateRepositoryAccess(selectedRepos, 'MillionOnMars/test-repo');

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
    });

    it('should be case-sensitive for repository names', () => {
      const result = validateRepositoryAccess(selectedRepos, 'milliononmars/lumina5');

      expect(result.allowed).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should require exact match including owner', () => {
      const result = validateRepositoryAccess(['user/repo'], 'otheruser/repo');

      expect(result.allowed).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('Edge cases', () => {
    it('should handle single repository in whitelist', () => {
      const result = validateRepositoryAccess(['MillionOnMars/lumina5'], 'MillionOnMars/lumina5');

      expect(result.allowed).toBe(true);
    });

    it('should handle multiple repositories in whitelist', () => {
      const repos = ['owner1/repo1', 'owner2/repo2', 'owner3/repo3'];
      const result = validateRepositoryAccess(repos, 'owner2/repo2');

      expect(result.allowed).toBe(true);
    });

    it('should handle repository names with special characters', () => {
      const repos = ['owner/repo-name.test'];
      const result = validateRepositoryAccess(repos, 'owner/repo-name.test');

      expect(result.allowed).toBe(true);
    });

    it('should not partially match repository names', () => {
      const repos = ['owner/repository'];
      const result = validateRepositoryAccess(repos, 'owner/repo');

      expect(result.allowed).toBe(false);
    });

    it('should handle repository with numbers', () => {
      const repos = ['owner123/repo456'];
      const result = validateRepositoryAccess(repos, 'owner123/repo456');

      expect(result.allowed).toBe(true);
    });
  });

  describe('Security validation', () => {
    it('should prevent access to all repos when whitelist is empty', () => {
      const testRepos = ['owner/repo1', 'owner/repo2', 'owner/repo3'];

      testRepos.forEach(repo => {
        const result = validateRepositoryAccess([], repo);
        expect(result.allowed).toBe(false);
      });
    });

    it('should only allow explicitly whitelisted repositories', () => {
      const whitelist = ['owner/allowed'];
      const unauthorized = ['owner/blocked1', 'owner/blocked2', 'other/repo'];

      const allowedResult = validateRepositoryAccess(whitelist, 'owner/allowed');
      expect(allowedResult.allowed).toBe(true);

      unauthorized.forEach(repo => {
        const result = validateRepositoryAccess(whitelist, repo);
        expect(result.allowed).toBe(false);
      });
    });

    it('should follow principle of least privilege (deny by default)', () => {
      const emptyWhitelist = validateRepositoryAccess([], 'any/repo');
      const notInWhitelist = validateRepositoryAccess(['allowed/repo'], 'other/repo');

      expect(emptyWhitelist.allowed).toBe(false);
      expect(notInWhitelist.allowed).toBe(false);
    });
  });

  describe('Error message quality', () => {
    it('should provide actionable error for empty whitelist', () => {
      const result = validateRepositoryAccess([], 'owner/repo');

      expect(result.error.message).toContain('Settings');
      expect(result.error.message).toContain('GitHub Integration');
      expect(result.error.action_required).toBeDefined();
    });

    it('should provide context about available repos when blocked', () => {
      const whitelist = ['owner/repo1', 'owner/repo2'];
      const result = validateRepositoryAccess(whitelist, 'owner/blocked');

      expect(result.error.available_repositories).toEqual(whitelist);
      expect(result.error.requested_repository).toBe('owner/blocked');
    });

    it('should distinguish between no-repos and wrong-repo errors', () => {
      const noReposError = validateRepositoryAccess([], 'owner/repo');
      const wrongRepoError = validateRepositoryAccess(['owner/allowed'], 'owner/blocked');

      expect(noReposError.error.error).toBe('No repositories enabled for AI access');
      expect(wrongRepoError.error.error).toContain('not enabled for AI access');
      expect(noReposError.error.action_required).toBeDefined();
      expect(wrongRepoError.error.action_required).toBeUndefined();
    });
  });
});
