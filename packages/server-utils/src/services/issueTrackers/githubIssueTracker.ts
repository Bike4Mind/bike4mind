/**
 * GitHub Issue Tracker Implementation
 *
 * Wraps the existing GitHubService to implement the IssueTrackerService interface.
 * Uses system-level GitHub connection for authentication.
 */

import { GitHubService } from '../githubService';
import {
  formatFingerprintComment,
  extractFingerprintFromIssueBody,
  extractSemanticFingerprintFromIssueBody,
} from '../liveopsFingerprint';
import type {
  IssueTrackerService,
  IssueTrackerLogger,
  CreateIssueParams,
  CreatedIssue,
  ExistingIssue,
  HealthCheckResult,
} from './types';

/**
 * Priority label colors for GitHub
 */
const PRIORITY_COLORS: Record<string, string> = {
  P0: 'd73a4a', // red
  P1: 'ff7518', // orange
  P2: 'fbca04', // yellow
  P3: '0e8a16', // green
};

/**
 * GitHub Issue Tracker
 *
 * Implements the IssueTrackerService interface for GitHub repositories.
 * Labels are automatically created if they don't exist (GitHub requires
 * labels to exist before applying them to issues).
 */
export class GitHubIssueTracker implements IssueTrackerService {
  readonly type = 'github' as const;
  private githubService: GitHubService | null = null;
  private repoFullName: string;

  constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly logger: IssueTrackerLogger,
    private readonly organizationId?: string | null
  ) {
    this.repoFullName = `${owner}/${repo}`;
  }

  /**
   * Initialize the GitHub service connection.
   * Org-scoped configs use the org's own connection with no system fallback,
   * so one org's triage can never touch another org's GitHub.
   */
  private async ensureInitialized(): Promise<GitHubService> {
    if (!this.githubService) {
      if (this.organizationId) {
        this.githubService = await GitHubService.forOrganization(this.organizationId, this.logger);
        if (!this.githubService) {
          throw new Error('Failed to initialize GitHub service - no connection available for organization');
        }
      } else {
        this.githubService = await GitHubService.forSystem(this.logger);
        if (!this.githubService) {
          throw new Error('Failed to initialize GitHub service - no system connection available');
        }
      }
    }
    return this.githubService;
  }

  /**
   * Ensure a label exists, creating it if necessary.
   * Returns the actual label name (which may differ in case) or null if failed.
   */
  private async ensureLabel(
    service: GitHubService,
    name: string,
    color: string,
    description: string
  ): Promise<string | null> {
    const label = await service.ensureLabelExists(this.repoFullName, {
      name,
      color,
      description,
    });

    if (!label) {
      this.logger.warn(`[GITHUB-TRACKER] Failed to ensure label exists: ${name}`, {
        repo: this.repoFullName,
        label: name,
      });
      return null;
    }

    // Return the actual label name from the repo (may differ in case)
    return label.name;
  }

  /**
   * Create a new issue in GitHub
   */
  async createIssue(params: CreateIssueParams): Promise<CreatedIssue | null> {
    try {
      const service = await this.ensureInitialized();

      // Ensure liveops label exists and get actual name
      const liveopsLabel = await this.ensureLabel(service, 'liveops', 'f9d0c4', 'Automated LiveOps triage');
      if (!liveopsLabel) return null;

      // Ensure bug label exists and get actual name
      const bugLabel = await this.ensureLabel(service, 'bug', 'd73a4a', "Something isn't working");
      if (!bugLabel) return null;

      // Ensure priority label exists and get actual name
      const priorityColor = PRIORITY_COLORS[params.priority] || 'ffffff';
      const priorityLabel = await this.ensureLabel(
        service,
        params.priority,
        priorityColor,
        `Priority ${params.priority}`
      );
      if (!priorityLabel) return null;

      // Ensure regression label exists if needed and get actual name
      let regressionLabel: string | null = null;
      if (params.isRegression) {
        regressionLabel = await this.ensureLabel(
          service,
          'regression',
          'b60205',
          'Bug that reoccurred after being fixed'
        );
        if (!regressionLabel) return null;
      }

      // Build labels array using actual label names from the repo
      const labels = [bugLabel, liveopsLabel, priorityLabel];
      if (regressionLabel) {
        labels.push(regressionLabel);
      }

      // Format body with fingerprint comment (guard empty fingerprint)
      const bodyWithFingerprint = params.fingerprint
        ? `${params.body}\n\n${formatFingerprintComment(params.fingerprint)}`
        : params.body;

      const issue = await service.createIssue(this.repoFullName, {
        title: `[LiveOps] ${params.title}`,
        body: bodyWithFingerprint,
        labels,
      });

      if (!issue) {
        this.logger.error('[GITHUB-TRACKER] Failed to create issue: GitHubService returned null');
        return null;
      }

      this.logger.info('[GITHUB-TRACKER] Created issue', {
        repo: this.repoFullName,
        issueNumber: issue.number,
        title: params.title,
        priority: params.priority,
        url: issue.html_url,
      });

      return {
        id: String(issue.number),
        key: `${this.repoFullName}#${issue.number}`,
        url: issue.html_url,
        title: issue.title,
      };
    } catch (error) {
      this.logger.error('[GITHUB-TRACKER] Failed to create issue', {
        repo: this.repoFullName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Search for existing open issues with the liveops label
   */
  async searchExistingIssues(): Promise<ExistingIssue[]> {
    try {
      const service = await this.ensureInitialized();

      // Search for open issues with liveops label
      const issues = await service.searchIssues(this.repoFullName, 'is:issue is:open label:liveops');

      return issues.map(issue => ({
        id: String(issue.number),
        key: `${this.repoFullName}#${issue.number}`,
        title: issue.title,
        state: 'open' as const,
        labels: issue.labels.map(l => l.name),
        fingerprint: extractFingerprintFromIssueBody(issue.body),
        semanticFingerprint: extractSemanticFingerprintFromIssueBody(issue.body),
        body: issue.body ?? undefined,
        createdAt: issue.created_at,
        url: issue.html_url,
      }));
    } catch (error) {
      this.logger.error('[GITHUB-TRACKER] Failed to search existing issues', {
        repo: this.repoFullName,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Fetch recently closed issues for regression detection
   */
  async fetchRecentlyClosedIssues(lookbackDays: number): Promise<ExistingIssue[]> {
    try {
      const service = await this.ensureInitialized();

      const lookbackDate = new Date();
      lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);
      const dateStr = lookbackDate.toISOString().split('T')[0]; // YYYY-MM-DD format

      // Search for closed issues with liveops label within lookback period
      const query = `is:issue is:closed label:liveops closed:>${dateStr}`;
      const issues = await service.searchIssues(this.repoFullName, query);

      return issues.map(issue => ({
        id: String(issue.number),
        key: `${this.repoFullName}#${issue.number}`,
        title: issue.title,
        state: 'closed' as const,
        labels: issue.labels.map(l => l.name),
        fingerprint: extractFingerprintFromIssueBody(issue.body),
        semanticFingerprint: extractSemanticFingerprintFromIssueBody(issue.body),
        body: issue.body ?? undefined,
        createdAt: issue.created_at,
        // Note: closed_at is not available in our GitHubIssue type
        url: issue.html_url,
      }));
    } catch (error) {
      this.logger.error('[GITHUB-TRACKER] Failed to fetch recently closed issues', {
        repo: this.repoFullName,
        lookbackDays,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Check if the GitHub connection is healthy
   */
  async checkHealth(): Promise<HealthCheckResult> {
    try {
      const service = await this.ensureInitialized();

      // Try to get repository info to verify access
      const repo = await service.getRepository(this.repoFullName);

      if (!repo) {
        return {
          healthy: false,
          error: `Repository ${this.repoFullName} not accessible`,
          details: {
            connectionValid: true,
            projectAccessible: false,
            canCreateIssues: false,
          },
        };
      }

      // Check if we can list labels (indicates we have at least read access)
      // If the API call succeeds without throwing, we have repository access
      await service.listLabels(this.repoFullName);

      return {
        healthy: true,
        details: {
          connectionValid: true,
          projectAccessible: true,
          canCreateIssues: true, // Assuming we have write access if we can access repo
        },
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
        details: {
          connectionValid: false,
          projectAccessible: false,
          canCreateIssues: false,
        },
      };
    }
  }
}
