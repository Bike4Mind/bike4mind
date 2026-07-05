/**
 * Server-side replacement for the GitHub Actions workflow data collection.
 * Uses GitHubService.forSystem() to access the GitHub API (same pattern as LiveOps triage).
 *
 * Collects merged PRs and commits for a date, applies noise filtering, and
 * returns a WhatsNewGenerationPayload-compatible object.
 */

import { GitHubService } from '@server/services/githubService';
import { Logger } from '@bike4mind/observability';
import type { WhatsNewGenerationPayload } from '@server/queueHandlers/types';

// Default repository configuration
// These could be moved to WhatsNewConfig AdminSettings in a future iteration
const DEFAULT_REPOSITORY = 'MillionOnMars/lumina5';
const DEFAULT_TARGET_BRANCH = 'main';

/**
 * Noise patterns to filter out non-user-facing PRs
 * Ported from .github/workflows/generate-whats-new-modal-reusable.yml lines 94-117
 */
const NOISE_PATTERNS = [
  /^merge (branch|pull request|pr)/i,
  /^chore\(deps\)/i,
  /^bump .+ from .+ to/i,
  /\btypo\b/i,
  /^docs?:/i,
  /^style:/i,
  /^ci:/i,
  /^test:/i,
  /^chore: (clean|format|lint)/i,
  /^revert:/i,
];

/**
 * Result of data collection for a single date
 */
export interface CollectedData {
  /** Payload ready for SQS dispatch */
  payload: Omit<WhatsNewGenerationPayload, 'correlationId' | 'environment'>;
  /** Number of raw PRs before filtering */
  rawPRCount: number;
  /** Number of PRs after noise filtering */
  filteredPRCount: number;
  /** Number of commits collected */
  commitCount: number;
}

/**
 * Check if a PR title matches noise patterns
 */
function isNoisePR(title: string): boolean {
  return NOISE_PATTERNS.some(pattern => pattern.test(title));
}

/**
 * Collect PR and commit data for a specific date.
 *
 * @param targetDate - Publication date (YYYY-MM-DD); PRs from the previous day are collected.
 * @param logger - Logger instance
 * @param options - Optional overrides for repository and branch
 * @returns CollectedData or null if GitHubService is unavailable
 */
export async function collectDataForDate(
  targetDate: string,
  logger: Logger,
  options?: { repository?: string; targetBranch?: string }
): Promise<CollectedData | null> {
  const repository = options?.repository || DEFAULT_REPOSITORY;
  const targetBranch = options?.targetBranch || DEFAULT_TARGET_BRANCH;

  logger.info('[WhatsNewDataCollector] Starting data collection', {
    targetDate,
    repository,
    targetBranch,
  });

  // Get GitHub service using system default connection
  const github = await GitHubService.forSystem(logger);
  if (!github) {
    logger.error('[WhatsNewDataCollector] GitHubService.forSystem() returned null - credentials missing or disabled');
    return null;
  }

  // targetDate is the publication date; PRs merged the previous day
  const since = new Date(`${targetDate}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 1); // day N-1 00:00:00Z
  const until = new Date(`${targetDate}T00:00:00Z`); // day N 00:00:00Z (exclusive)

  // Fetch merged PRs to target branch
  logger.info('[WhatsNewDataCollector] Fetching merged PRs...', { base: targetBranch, since: since.toISOString() });

  const mergedPRs = await github.listMergedPullRequests(repository, {
    base: targetBranch,
    since,
    perPage: 100,
  });

  // Filter to PRs merged within the target date
  const prsForDate = mergedPRs.filter(pr => {
    if (!pr.merged_at) return false;
    const mergedAt = new Date(pr.merged_at);
    return mergedAt >= since && mergedAt < until;
  });

  logger.info(`[WhatsNewDataCollector] Found ${prsForDate.length} merged PRs for date`, {
    rawCount: mergedPRs.length,
    dateFilteredCount: prsForDate.length,
  });

  // Apply noise filtering
  const filteredPRs = prsForDate.filter(pr => {
    if (isNoisePR(pr.title)) {
      logger.debug(`[WhatsNewDataCollector] Filtering noise PR: ${pr.title}`);
      return false;
    }
    return true;
  });

  logger.info(`[WhatsNewDataCollector] After noise filtering: ${filteredPRs.length} user-facing PRs`);

  if (filteredPRs.length === 0) {
    logger.info('[WhatsNewDataCollector] No user-facing PRs found for date, returning empty payload');
    return {
      payload: {
        generatedDate: targetDate,
        repositoryUrl: `https://github.com/${repository}`,
        releases: [],
        commits: [],
        pullRequests: [],
      },
      rawPRCount: prsForDate.length,
      filteredPRCount: 0,
      commitCount: 0,
    };
  }

  // Fetch commits for the date range
  logger.info('[WhatsNewDataCollector] Fetching commits...');

  const commits = await github.listCommits(repository, {
    sha: targetBranch,
    since,
    perPage: 100,
  });

  // Filter commits to the target date
  const commitsForDate = commits.filter(c => {
    if (!c.date) return false;
    const commitDate = new Date(c.date);
    return commitDate >= since && commitDate < until;
  });

  logger.info(`[WhatsNewDataCollector] Found ${commitsForDate.length} commits for date`);

  // Fetch CHANGELOG excerpt (graceful degradation if missing)
  let changelogExcerpt: string | undefined;
  const extractExcerpt = (content: string): string => {
    const lines = content.split('\n');
    const excerptLines: string[] = [];
    let sectionCount = 0;
    for (const line of lines) {
      if (line.startsWith('## ')) {
        sectionCount++;
        if (sectionCount === 2) break;
      }
      if (sectionCount === 1) {
        excerptLines.push(line);
      }
    }
    return excerptLines.join('\n').substring(0, 2000);
  };
  try {
    let changelogContent = await github.getFileContent(repository, 'CHANGELOG.md', targetBranch);
    // Fallback to 'main' if configured branch lacks CHANGELOG.md
    if (!changelogContent && targetBranch !== 'main') {
      logger.info('[WhatsNewDataCollector] CHANGELOG.md not found on configured branch, trying main', { targetBranch });
      changelogContent = await github.getFileContent(repository, 'CHANGELOG.md', 'main');
    }
    if (changelogContent) {
      changelogExcerpt = extractExcerpt(changelogContent);
    }
  } catch (error) {
    logger.warn('[WhatsNewDataCollector] Failed to fetch CHANGELOG.md (non-critical)', {
      error: error instanceof Error ? error.message : String(error),
      targetBranch,
    });
  }

  // Build payload
  const payload: Omit<WhatsNewGenerationPayload, 'correlationId' | 'environment'> = {
    generatedDate: targetDate,
    repositoryUrl: `https://github.com/${repository}`,
    releases: [],
    commits: commitsForDate.map(c => ({
      sha: c.sha,
      message: c.message,
      author: c.author,
      date: c.date,
    })),
    pullRequests: filteredPRs.map(pr => ({
      number: pr.number,
      title: pr.title,
      body: pr.body,
      mergedAt: pr.merged_at ?? undefined,
      url: pr.html_url,
      author: pr.user?.login,
    })),
    changelogExcerpt,
  };

  logger.info('[WhatsNewDataCollector] Data collection complete', {
    targetDate,
    prs: filteredPRs.length,
    commits: commitsForDate.length,
    hasChangelog: !!changelogExcerpt,
  });

  return {
    payload,
    rawPRCount: prsForDate.length,
    filteredPRCount: filteredPRs.length,
    commitCount: commitsForDate.length,
  };
}
