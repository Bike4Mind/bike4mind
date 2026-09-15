import { EntityMentionSource } from '../types';
import { EntityExtractor, ExtractionResult } from './types';

/**
 * Regex patterns for extracting GitHub entities from text
 */
const GITHUB_PATTERNS = {
  // GitHub URL patterns
  // https://github.com/owner/repo
  repoUrl: /https?:\/\/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)(?:\/|$|\s|[)\]>])/gi,

  // https://github.com/owner/repo/pull/<number>
  prUrl: /https?:\/\/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\/pull\/(\d+)/gi,

  // https://github.com/owner/repo/issues/<number>
  issueUrl: /https?:\/\/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\/issues\/(\d+)/gi,

  // owner/repo format (e.g., "owner/repo")
  // Must not be preceded by @ (to avoid email-like patterns)
  // Must not be followed by common file extensions
  repoSlash:
    /(?<![/@])([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)(?!\.(?:js|ts|tsx|jsx|json|md|css|html|py|go|rs|java|rb|php|c|cpp|h|hpp))/g,
};

/**
 * GitHub entity extractor using regex patterns
 */
export class GitHubExtractor implements EntityExtractor {
  /**
   * Extract GitHub entities from text
   */
  extract(text: string, source: EntityMentionSource): ExtractionResult {
    const entities: ExtractionResult['entities'] = [];
    const seenRepos = new Set<string>();
    const seenPRs = new Set<string>();
    const seenIssues = new Set<string>();

    // Extract PR URLs (includes repo context)
    let match;
    GITHUB_PATTERNS.prUrl.lastIndex = 0;
    while ((match = GITHUB_PATTERNS.prUrl.exec(text)) !== null) {
      const [, owner, repo, number] = match;
      const key = `${owner}/${repo}#${number}`;
      if (!seenPRs.has(key)) {
        seenPRs.add(key);
        entities.push({
          entity: {
            type: 'github_pr',
            entity: { owner, repo, number: parseInt(number, 10) },
          },
          source,
        });
        // Also add the repo
        const repoKey = `${owner}/${repo}`;
        if (!seenRepos.has(repoKey)) {
          seenRepos.add(repoKey);
          entities.push({
            entity: {
              type: 'github_repo',
              entity: { owner, repo },
            },
            source,
          });
        }
      }
    }

    // Extract Issue URLs (includes repo context)
    GITHUB_PATTERNS.issueUrl.lastIndex = 0;
    while ((match = GITHUB_PATTERNS.issueUrl.exec(text)) !== null) {
      const [, owner, repo, number] = match;
      const key = `${owner}/${repo}#${number}`;
      if (!seenIssues.has(key)) {
        seenIssues.add(key);
        entities.push({
          entity: {
            type: 'github_issue',
            entity: { owner, repo, number: parseInt(number, 10) },
          },
          source,
        });
        // Also add the repo
        const repoKey = `${owner}/${repo}`;
        if (!seenRepos.has(repoKey)) {
          seenRepos.add(repoKey);
          entities.push({
            entity: {
              type: 'github_repo',
              entity: { owner, repo },
            },
            source,
          });
        }
      }
    }

    // Extract Repo URLs (without PR/issue context)
    GITHUB_PATTERNS.repoUrl.lastIndex = 0;
    while ((match = GITHUB_PATTERNS.repoUrl.exec(text)) !== null) {
      const [, owner, repo] = match;
      const key = `${owner}/${repo}`;
      if (!seenRepos.has(key)) {
        seenRepos.add(key);
        entities.push({
          entity: {
            type: 'github_repo',
            entity: { owner, repo: repo.replace(/\.git$/, '') },
          },
          source,
        });
      }
    }

    // Extract owner/repo format
    GITHUB_PATTERNS.repoSlash.lastIndex = 0;
    while ((match = GITHUB_PATTERNS.repoSlash.exec(text)) !== null) {
      const [, owner, repo] = match;
      // Skip if owner looks like a protocol or common prefix
      if (['http', 'https', 'git', 'ssh', 'ftp'].includes(owner.toLowerCase())) {
        continue;
      }
      // Skip common false positives
      const skipOwners = [
        'node_modules',
        'src',
        'dist',
        'build',
        'lib',
        'bin',
        // URL components that shouldn't be treated as owners
        'github',
        'com',
        'www',
        'api',
        'raw',
        'gist',
      ];
      const skipRepos = [
        // GitHub URL path segments that aren't repos
        'pull',
        'pulls',
        'issue',
        'issues',
        'blob',
        'tree',
        'commit',
        'commits',
        'compare',
        'releases',
        'tags',
        'branches',
        'actions',
        'settings',
        'wiki',
        'projects',
        'security',
        'pulse',
        'graphs',
        'network',
      ];
      if (skipOwners.includes(owner.toLowerCase())) {
        continue;
      }
      if (skipRepos.includes(repo.toLowerCase())) {
        continue;
      }
      const key = `${owner}/${repo}`;
      if (!seenRepos.has(key)) {
        seenRepos.add(key);
        entities.push({
          entity: {
            type: 'github_repo',
            entity: { owner, repo: repo.replace(/\.git$/, '') },
          },
          source,
        });
      }
    }

    return { entities };
  }
}

/**
 * Singleton instance for convenience
 */
export const githubExtractor = new GitHubExtractor();
