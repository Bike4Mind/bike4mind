/**
 * Issue Tracker Factory
 *
 * Factory function for creating issue tracker instances based on configuration.
 * Supports GitHub and Jira issue trackers.
 */

import type { ILiveopsTriageConfigDocument } from '@bike4mind/database';
import { GitHubIssueTracker } from './githubIssueTracker';
import { JiraIssueTracker } from './jiraIssueTracker';
import type { IssueTrackerService, IssueTrackerLogger } from './types';

export * from './types';
export { GitHubIssueTracker } from './githubIssueTracker';
export { JiraIssueTracker } from './jiraIssueTracker';

/**
 * Create an issue tracker service based on the configuration
 *
 * @param config - LiveOps triage configuration
 * @param logger - Logger instance for the tracker
 * @returns Issue tracker service instance
 * @throws Error if configuration is invalid for the selected tracker type
 */
export function createIssueTracker(
  config: ILiveopsTriageConfigDocument,
  logger: IssueTrackerLogger
): IssueTrackerService {
  if (config.issueTracker === 'jira') {
    if (!config.jiraProjectKey) {
      throw new Error('Jira project key is required for Jira issue tracker');
    }
    return new JiraIssueTracker(config.jiraProjectKey, config.jiraIssueType || 'Bug', logger);
  }

  // Default to GitHub
  if (!config.githubOwner || !config.githubRepo) {
    throw new Error('GitHub owner and repo are required for GitHub issue tracker');
  }
  return new GitHubIssueTracker(config.githubOwner, config.githubRepo, logger);
}
