/**
 * Jira Issue Tracker Implementation
 *
 * Uses the Jira REST API v3 to implement the IssueTrackerService interface.
 * Uses system-level Atlassian credentials for authentication.
 */

import { JiraApi, type JiraConfig } from '@bike4mind/common/jira/api';
import { getAtlassianConfig } from '@bike4mind/common/atlassian/config';
import { formatFingerprintComment, extractFingerprintFromIssueBody } from '../liveopsFingerprint';
import type {
  IssueTrackerService,
  IssueTrackerLogger,
  CreateIssueParams,
  CreatedIssue,
  ExistingIssue,
  HealthCheckResult,
  IssuePriority,
} from './types';

/**
 * Priority mapping from our priority levels to Jira priority names
 */
const PRIORITY_MAP: Record<IssuePriority, string> = {
  P0: 'Highest',
  P1: 'High',
  P2: 'Medium',
  P3: 'Low',
};

/**
 * Retry configuration for Jira API calls
 */
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
};

/**
 * Sleep utility for retries
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Jira Issue Tracker
 *
 * Implements the IssueTrackerService interface for Jira projects.
 * Labels are automatically created on first use in Jira (unlike GitHub).
 */
export class JiraIssueTracker implements IssueTrackerService {
  readonly type = 'jira' as const;
  private jiraApi: JiraApi | null = null;
  private jiraConfig: JiraConfig | null = null;

  constructor(
    private readonly projectKey: string,
    private readonly issueType: string = 'Bug',
    private readonly logger: IssueTrackerLogger
  ) {}

  /**
   * Initialize the Jira API connection
   */
  private ensureInitialized(): JiraApi {
    if (!this.jiraApi || !this.jiraConfig) {
      try {
        const atlassianConfig = getAtlassianConfig();
        this.jiraConfig = atlassianConfig.jira;
        this.jiraApi = new JiraApi(this.jiraConfig);
      } catch (error) {
        throw new Error(`Failed to initialize Jira API: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return this.jiraApi;
  }

  /**
   * Get the Jira config, ensuring initialization has occurred
   */
  private getConfig(): JiraConfig {
    if (!this.jiraConfig) {
      throw new Error('Jira API not initialized - call ensureInitialized() first');
    }
    return this.jiraConfig;
  }

  /**
   * Execute an API call with retry logic
   */
  private async withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
    let lastError: Error | null = null;
    let delayMs = RETRY_CONFIG.initialDelayMs;

    for (let attempt = 1; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if we should retry
        const errorMessage = lastError.message;
        const isRetryable = RETRY_CONFIG.retryableStatusCodes.some(
          code => errorMessage.includes(`(${code})`) || errorMessage.includes(`status ${code}`)
        );

        if (!isRetryable || attempt === RETRY_CONFIG.maxRetries) {
          throw lastError;
        }

        this.logger.warn(
          `[JIRA-TRACKER] ${operationName} failed, retrying (attempt ${attempt}/${RETRY_CONFIG.maxRetries})`,
          {
            error: errorMessage,
            delayMs,
          }
        );

        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, RETRY_CONFIG.maxDelayMs);
      }
    }

    throw lastError;
  }

  /**
   * Create a new issue in Jira
   */
  async createIssue(params: CreateIssueParams): Promise<CreatedIssue | null> {
    try {
      const api = this.ensureInitialized();

      // Build labels array - Jira auto-creates labels on first use
      const labels = ['liveops-triage', 'bug', params.priority];
      if (params.isRegression) {
        labels.push('regression');
      }

      // Format body with fingerprint comment (plain text in description is preserved)
      const descriptionWithFingerprint = `${params.body}\n\n${formatFingerprintComment(params.fingerprint)}`;

      const priorityName = PRIORITY_MAP[params.priority];

      // Create the issue using retry logic
      const result = await this.withRetry(
        () =>
          api.createIssue({
            projectKey: this.projectKey,
            summary: `[LiveOps] ${params.title}`,
            description: descriptionWithFingerprint,
            issueTypeName: this.issueType,
            labels,
            priority: priorityName,
          }),
        'createIssue'
      );

      this.logger.info('[JIRA-TRACKER] Created issue', {
        projectKey: this.projectKey,
        issueKey: result.key,
        title: params.title,
        priority: params.priority,
        url: result.link,
      });

      return {
        id: result.id,
        key: result.key,
        url: result.link,
        title: params.title,
      };
    } catch (error) {
      this.logger.error('[JIRA-TRACKER] Failed to create issue', {
        projectKey: this.projectKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Search for existing open issues with the liveops-triage label
   */
  async searchExistingIssues(): Promise<ExistingIssue[]> {
    try {
      const api = this.ensureInitialized();

      // JQL to find open issues with liveops-triage label
      const jql = `project = "${this.projectKey}" AND labels = "liveops-triage" AND resolution = Unresolved ORDER BY created DESC`;

      // Raw search: the fingerprint lives in an HTML comment in the description body,
      // which the AI-facing formatter would strip - so we need the unformatted issue.
      const result = await this.withRetry(
        () =>
          api.searchIssuesRaw({
            jql,
            maxResults: 100,
            fields: ['summary', 'status', 'labels', 'created', 'description'],
          }),
        'searchExistingIssues'
      );

      return result.issues.map(issue => ({
        id: issue.id,
        key: issue.key,
        title: issue.fields.summary,
        state: 'open' as const,
        labels: issue.fields.labels || [],
        fingerprint: extractFingerprintFromIssueBody(
          typeof issue.fields.description === 'string'
            ? issue.fields.description
            : issue.fields.description?.content?.[0]?.content?.[0]?.text
        ),
        createdAt: issue.fields.created,
        url: `${this.getConfig().webBaseUrl}/browse/${issue.key}`,
      }));
    } catch (error) {
      this.logger.error('[JIRA-TRACKER] Failed to search existing issues', {
        projectKey: this.projectKey,
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
      const api = this.ensureInitialized();

      const lookbackDate = new Date();
      lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);
      const dateStr = lookbackDate.toISOString().split('T')[0]; // YYYY-MM-DD format

      // JQL to find closed issues with liveops-triage label resolved within lookback period
      const jql = `project = "${this.projectKey}" AND labels = "liveops-triage" AND resolution IS NOT EMPTY AND resolved >= "${dateStr}" ORDER BY resolved DESC`;

      // Raw search: see searchExistingIssues - the fingerprint and the raw
      // resolutiondate field require the unformatted issue.
      const result = await this.withRetry(
        () =>
          api.searchIssuesRaw({
            jql,
            maxResults: 100,
            fields: ['summary', 'status', 'labels', 'created', 'resolutiondate', 'description'],
          }),
        'fetchRecentlyClosedIssues'
      );

      return result.issues.map(issue => ({
        id: issue.id,
        key: issue.key,
        title: issue.fields.summary,
        state: 'closed' as const,
        labels: issue.fields.labels || [],
        fingerprint: extractFingerprintFromIssueBody(
          typeof issue.fields.description === 'string'
            ? issue.fields.description
            : issue.fields.description?.content?.[0]?.content?.[0]?.text
        ),
        createdAt: issue.fields.created,
        closedAt: issue.fields.resolutiondate,
        url: `${this.getConfig().webBaseUrl}/browse/${issue.key}`,
      }));
    } catch (error) {
      this.logger.error('[JIRA-TRACKER] Failed to fetch recently closed issues', {
        projectKey: this.projectKey,
        lookbackDays,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Check if the Jira connection is healthy
   */
  async checkHealth(): Promise<HealthCheckResult> {
    try {
      const api = this.ensureInitialized();

      // Try to get project info to verify access
      const project = await api.getProject({ projectKey: this.projectKey });

      if (!project) {
        return {
          healthy: false,
          error: `Project ${this.projectKey} not accessible`,
          details: {
            connectionValid: true,
            projectAccessible: false,
            canCreateIssues: false,
          },
        };
      }

      // Check if the project has the issue type we need
      const hasIssueType = project.issueTypes?.some(it => it.name?.toLowerCase() === this.issueType.toLowerCase());

      if (!hasIssueType) {
        return {
          healthy: false,
          error: `Issue type "${this.issueType}" not found in project ${this.projectKey}`,
          details: {
            connectionValid: true,
            projectAccessible: true,
            canCreateIssues: false,
          },
        };
      }

      return {
        healthy: true,
        details: {
          connectionValid: true,
          projectAccessible: true,
          canCreateIssues: true,
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
