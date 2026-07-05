import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

/**
 * LiveOps Triage Service
 *
 * Provides functionality for:
 * - Fetching error alerts from a configured Slack channel
 * - Triaging errors by priority using LLM
 * - Creating GitHub issues for untracked errors
 * - Posting triage summaries to Slack
 */

import { getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel, resolveDeprecatedModelId } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { apiKeyService } from '@bike4mind/services';
import {
  ChatModels,
  LiveopsTriageConfig,
  LiveopsTriageConfigSchema,
  LLMTriageResponseSchema,
  LIVEOPS_TRIAGE_VALIDATION_LIMITS,
} from '@bike4mind/common';
import {
  AdminSettings,
  apiKeyRepository,
  adminSettingsRepository,
  ILiveopsTriageConfigDocument,
} from '@bike4mind/database';
import type { IssueTrackerService, ExistingIssue as TrackerExistingIssue, CreateIssueParams } from './issueTrackers';
import { SlackClient, SlackMessage } from '@bike4mind/slack';
import { GitHubService } from './githubService';
import { getDefaultTemplateString, interpolateTemplate, PRIORITY_GUIDELINES } from './liveopsTriagePrompt';
import { getNextScheduledRun } from '@client/shared/liveopsScheduleUtils';
import {
  generateFingerprint,
  extractFingerprintFromIssueBody,
  formatFingerprintComment,
  extractErrorType,
  findBestTitleMatch,
  TitleMatchIssue,
  generateSemanticFingerprint,
  formatSemanticFingerprintComment,
  extractSemanticFingerprintFromIssueBody,
} from './liveopsFingerprint';
import { REQUIRED_LIVEOPS_LABELS, type GitHubLabelDef } from './issueLabels';

/**
 * Slack Block Kit types for proper type safety
 * @see https://api.slack.com/reference/block-kit/blocks
 */
interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}

interface SlackHeaderBlock {
  type: 'header';
  text: SlackTextObject;
}

interface SlackDividerBlock {
  type: 'divider';
}

interface SlackSectionBlock {
  type: 'section';
  text?: SlackTextObject;
  fields?: SlackTextObject[];
}

interface SlackContextBlock {
  type: 'context';
  elements: SlackTextObject[];
}

type SlackBlock = SlackHeaderBlock | SlackDividerBlock | SlackSectionBlock | SlackContextBlock;

// Token estimation constants
const CHARS_PER_TOKEN = 4;
const TOKENS_PER_MILLION = 1_000_000;

// LLM response safety limit
const MAX_RESPONSE_SIZE = 100000; // 100KB limit for LLM responses

// Default regression detection grace period (prevents false regressions from delayed alerts)
// Note: This is the fallback value; actual value comes from config.regressionGracePeriodHours
const DEFAULT_REGRESSION_GRACE_PERIOD_HOURS = 48;

/**
 * Format an issue as a single line for LLM prompt context.
 * Strips HTML comments and truncates body to 200 chars.
 */
function formatIssueForPrompt(i: ExistingIssue): string {
  const bodySnippet = i.body
    ? `\n  Body: ${i.body
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim()
        .slice(0, 200)}`
    : '';
  // Surface closedAt so the LLM can echo the real ISO timestamp for regression
  // matches instead of guessing or returning null.
  const closedAtNote = i.closedAt ? ` (closedAt: ${i.closedAt})` : '';
  return `- #${i.number}: ${i.title} [${i.labels.join(', ')}]${closedAtNote}${bodySnippet}`;
}

/**
 * Map tracker ExistingIssue to service ExistingIssue
 * The tracker has a different structure (id, key, url) than the service (number)
 */
function mapTrackerIssueToServiceIssue(trackerIssue: TrackerExistingIssue): ExistingIssue {
  // Extract issue number from key: GitHub "owner/repo#N" -> N,
  // Jira "PROJ-N" -> use the key's numeric part, or -1 if non-numeric.
  let issueNumber = -1;
  const githubMatch = trackerIssue.key.match(/#(\d+)$/);
  if (githubMatch) {
    issueNumber = parseInt(githubMatch[1], 10);
  } else {
    // Try to extract number from Jira key (PROJ-123)
    const jiraMatch = trackerIssue.key.match(/-(\d+)$/);
    if (jiraMatch) {
      issueNumber = parseInt(jiraMatch[1], 10);
    }
  }

  return {
    number: issueNumber,
    title: trackerIssue.title,
    state: trackerIssue.state,
    labels: trackerIssue.labels,
    createdAt: trackerIssue.createdAt,
    fingerprint: trackerIssue.fingerprint,
    closedAt: trackerIssue.closedAt,
    body: trackerIssue.body ?? undefined,
    semanticFingerprint: trackerIssue.semanticFingerprint ?? undefined,
  };
}

/**
 * Check if a triage result should be marked as a regression based on LLM matching a closed issue.
 * This handles cases where the closed issue doesn't have an embedded fingerprint (legacy issues).
 *
 * @param result - The triage result to potentially update
 * @param recentlyClosedIssues - List of recently closed issues to check against
 * @param gracePeriodHours - The regression grace period in hours
 * @returns true if result was mutated to mark as regression, false otherwise
 */
// Exported for testing - see liveopsTriageService.test.ts
export function checkLLMMatchedClosedIssueRegression(
  result: TriageResult,
  recentlyClosedIssues: ExistingIssue[],
  gracePeriodHours: number
): boolean {
  // When the LLM flags a regression (isRegression=true) but omits closedAt on
  // the matched closed issue, the early-return below skips every deterministic
  // recompute path, leaving the downstream Slack/GitHub formatters to render
  // their "closed previously" fallback indefinitely. Enrich closedAt from the
  // real GitHub source here so that fallback stays rare.
  if (result.isRegression && result.matchedClosedIssue && !result.matchedClosedIssue.closedAt) {
    const src = recentlyClosedIssues.find(i => i.number === result.matchedClosedIssue!.issueNumber);
    if (src?.closedAt) {
      result.matchedClosedIssue.closedAt = src.closedAt;
    }
  }

  // Only check if LLM matched to an existing issue and not already marked as regression
  if (!result.matchesExisting || result.isRegression) {
    return false;
  }

  const llmMatchedClosedIssue = recentlyClosedIssues.find(i => i.number === result.matchesExisting!.issueNumber);

  if (!llmMatchedClosedIssue || !llmMatchedClosedIssue.closedAt) {
    return false;
  }

  const closedAt = new Date(llmMatchedClosedIssue.closedAt).getTime();
  const gracePeriodMs = gracePeriodHours * 60 * 60 * 1000;

  if (Date.now() - closedAt > gracePeriodMs) {
    result.isRegression = true;
    result.matchedClosedIssue = {
      issueNumber: llmMatchedClosedIssue.number,
      title: llmMatchedClosedIssue.title,
      closedAt: llmMatchedClosedIssue.closedAt,
    };
    // Clear matchesExisting since this should create a new issue (regression)
    result.matchesExisting = null;
    return true;
  }

  return false;
}

/**
 * Default configuration for LiveOps Triage
 */
const DEFAULT_CONFIG: LiveopsTriageConfig = {
  enabled: false,
  slackWorkspaceId: undefined,
  slackChannelId: '',
  slackOutputChannelId: undefined,
  githubOwner: '',
  githubRepo: '',
  modelId: '',
  temperature: 0.3,
  maxTokens: 1000,
  timeoutMs: 60000,
  maxErrorsPerRun: 50,
  regressionLookbackDays: LIVEOPS_TRIAGE_VALIDATION_LIMITS.regressionLookbackDays.default,
  regressionGracePeriodHours: LIVEOPS_TRIAGE_VALIDATION_LIMITS.regressionGracePeriodHours.default,
  autoCreateIssues: false,
  runIntervalHours: LIVEOPS_TRIAGE_VALIDATION_LIMITS.runIntervalHours.default,
  postWhenNoErrors: true,
};

/**
 * Interface for triage result from LLM
 */
export interface TriageResult {
  alertId: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  category: 'database' | 'api' | 'auth' | 'frontend' | 'infrastructure' | 'llm' | 'integration' | 'other';
  title: string;
  body: string;
  labels: string[];
  matchesExisting: { issueNumber: number; title: string; state?: 'open' | 'closed' } | null;
  isRecurring: boolean;
  occurrenceCount: number;
  isRegression: boolean;
  /** Details of the closed issue this error is regressing from (when isRegression is true) */
  matchedClosedIssue?: {
    issueNumber: number;
    title: string;
    closedAt?: string | null; // ISO date string; may be absent when LLM omits it
  } | null;
  /** Deterministic fingerprint for deduplication (SHA-1 hash, 40 chars) */
  fingerprint?: string;
  /** Semantic fingerprint for looser matching (more aggressive normalization) */
  semanticFingerprint?: string | null;
}

/**
 * Interface for triage summary
 */
export interface TriageSummary {
  totalAlerts: number;
  newIssues: number;
  duplicates: number;
  regressions: number;
  p0Count: number;
  p1Count: number;
  p2Count: number;
  p3Count: number;
  recurringPatterns: string[];
  healthAssessment: string;
}

/**
 * Interface for LLM triage response
 */
export interface LLMTriageResponse {
  triageResults: TriageResult[];
  summary: TriageSummary;
}

/**
 * LLM Error categories for proper error handling and reporting
 */
export type LLMErrorCategory =
  | 'TIMEOUT'
  | 'SIZE_LIMIT'
  | 'RATE_LIMIT'
  | 'AUTH_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'API_ERROR'
  | 'PARSE_ERROR';

/**
 * Custom error class for categorized LLM errors
 */
export class LLMError extends Error {
  constructor(
    public readonly category: LLMErrorCategory,
    message: string
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/**
 * Interface for Slack alert
 */
export interface SlackAlert {
  ts: string;
  text: string;
  timestamp: Date;
  permalink?: string;
}

/**
 * Interface for GitHub issue (simplified)
 */
export interface ExistingIssue {
  number: number;
  title: string;
  state: string;
  labels: string[];
  createdAt: string;
  /** Issue body content (for fingerprint extraction) */
  body?: string;
  /** Extracted fingerprint from issue body (if present) */
  fingerprint?: string | null;
  /** Extracted semantic fingerprint from issue body (if present) */
  semanticFingerprint?: string | null;
  /** When the issue was closed (for regression grace period) */
  closedAt?: string;
}

/**
 * Result of the triage run
 */
export interface TriageRunResult {
  status: 'success' | 'partial' | 'failed';
  errorsProcessed: number;
  issuesCreated: number[];
  issuesDeduplicated: number;
  p0Issues: number[];
  p1Issues: number[];
  summary?: TriageSummary;
  error?: string;
}

/**
 * Dry run result with detailed information
 */
export interface DryRunResult {
  status: 'success' | 'failed';
  dryRun: true;
  lookbackHours: number;
  alertsFetched: number;
  alertsToProcess: number;
  existingIssuesFound: number;
  triageResults: TriageResult[];
  summary: TriageSummary;
  issuesWouldCreate: Array<{
    title: string;
    priority: string;
    category: string;
    body: string;
    labels: string[];
    isRecurring: boolean;
    occurrenceCount: number;
    isRegression: boolean;
  }>;
  issuesWouldSkip: Array<{
    title: string;
    priority: string;
    matchesExisting: { issueNumber: number; title: string; state?: 'open' | 'closed' };
  }>;
  llmDetails: {
    modelId: string;
    promptLength: number;
    responseLength: number;
    estimatedCost: string;
  };
  error?: string;
}

/**
 * Required GitHub labels for LiveOps triage.
 * Re-exported from shared module for backward compatibility.
 * @see issueLabels.ts for the centralized label definitions
 */
export const REQUIRED_GITHUB_LABELS: GitHubLabelDef[] = REQUIRED_LIVEOPS_LABELS;

/**
 * Calculate estimated cost for LLM API call
 */
function calculateLLMCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing: Record<string, { input: number; output: number }> = {
    [ChatModels.CLAUDE_5_SONNET_BEDROCK]: { input: 3.0, output: 15.0 },
    [ChatModels.CLAUDE_4_6_SONNET_BEDROCK]: { input: 3.0, output: 15.0 },
    [ChatModels.CLAUDE_4_5_HAIKU_BEDROCK]: { input: 0.8, output: 4.0 },
    [ChatModels.GPT4o]: { input: 5.0, output: 15.0 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
  };

  const modelPricing = pricing[model] || { input: 3.0, output: 15.0 };

  const inputCost = (inputTokens / TOKENS_PER_MILLION) * modelPricing.input;
  const outputCost = (outputTokens / TOKENS_PER_MILLION) * modelPricing.output;

  return inputCost + outputCost;
}

/**
 * Sanitize error message to remove sensitive data before sending to LLM or returning in API responses.
 * This is exported so API endpoints can use it for error sanitization.
 */
export function sanitizeErrorMessage(text: string): string {
  // Remove API keys and tokens - comprehensive patterns
  let sanitized = text.replace(/([A-Za-z0-9_-]{20,})/g, match => {
    // Check if it looks like a known token/key pattern
    if (
      /^(sk-|pk-|xox[bsap]-|ghp_|gho_|ghu_|ghs_|ghr_)/i.test(match) || // OpenAI, Slack, GitHub
      /^sk-ant-/i.test(match) || // Anthropic
      /^AKIA[A-Z0-9]{16}$/i.test(match) || // AWS Access Key ID
      /^AIza[A-Za-z0-9_-]{35}$/.test(match) // Google API Key
    ) {
      return '[REDACTED_TOKEN]';
    }
    // Very long strings that could be tokens/secrets
    if (match.length > 40) {
      return '[REDACTED_LONG_STRING]';
    }
    return match;
  });

  // Remove AWS Secret Access Keys (40 char base64-like strings often following AKIA)
  sanitized = sanitized.replace(
    /(?:secret[_\s]*(?:access)?[_\s]*key["\s:=]+)([A-Za-z0-9+/=]{40})/gi,
    '[REDACTED_AWS_SECRET]'
  );

  // Remove PEM private keys
  sanitized = sanitized.replace(
    /-----BEGIN[A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]+PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]'
  );

  // Remove email addresses (PII)
  sanitized = sanitized.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]');

  // Remove IP addresses
  sanitized = sanitized.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[REDACTED_IP]');

  // Remove MongoDB connection strings
  sanitized = sanitized.replace(/mongodb(\+srv)?:\/\/[^"'\s]+/gi, '[REDACTED_MONGODB_URI]');

  // Remove generic URLs with credentials
  sanitized = sanitized.replace(/https?:\/\/[^:]+:[^@]+@[^"'\s]+/gi, '[REDACTED_URL_WITH_CREDS]');

  // Remove Bearer tokens in headers
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED_TOKEN]');

  return sanitized;
}

export class LiveopsTriageService {
  private logger: Logger;
  private slackClient: SlackClient | null = null;
  private githubService: GitHubService | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Initialize Slack client
   */
  async initSlackClient(botToken: string): Promise<void> {
    this.slackClient = new SlackClient(botToken, this.logger);
    this.logger.info('Slack client initialized');
  }

  /**
   * Initialize GitHub service
   */
  initGitHubService(service: GitHubService): void {
    this.githubService = service;
    this.logger.info('GitHub service initialized');
  }

  /**
   * Get LiveOps Triage configuration from database
   */
  async getConfig(): Promise<LiveopsTriageConfig> {
    try {
      const setting = await AdminSettings.findOne({
        settingName: 'liveopsTriageConfig',
      })
        .lean()
        .exec();

      if (!setting) {
        this.logger.info('LiveOps Triage config not found, using defaults');
        return DEFAULT_CONFIG;
      }

      try {
        // Clamp timeoutMs to valid range before parsing (handles existing configs with old max value)
        // This is needed because the max was reduced from 600000ms to 180000ms
        const rawConfig = setting.settingValue as unknown as Record<string, unknown>;
        if (rawConfig && typeof rawConfig.timeoutMs === 'number') {
          const maxTimeout = LIVEOPS_TRIAGE_VALIDATION_LIMITS.timeoutMs.max;
          if (rawConfig.timeoutMs > maxTimeout) {
            this.logger.warn(`Clamping timeoutMs from ${rawConfig.timeoutMs}ms to ${maxTimeout}ms (max limit reduced)`);
            rawConfig.timeoutMs = maxTimeout;
          }
        }

        const config = LiveopsTriageConfigSchema.parse(rawConfig);
        return config;
      } catch (parseError) {
        this.logger.error('Invalid LiveOps Triage config in database, using defaults:', parseError);
        return DEFAULT_CONFIG;
      }
    } catch (error) {
      this.logger.error('Error getting LiveOps Triage config:', error);
      return DEFAULT_CONFIG;
    }
  }

  /**
   * Update LiveOps Triage configuration
   */
  async updateConfig(config: LiveopsTriageConfig): Promise<void> {
    try {
      const validatedConfig = LiveopsTriageConfigSchema.parse(config);

      await AdminSettings.findOneAndUpdate(
        { settingName: 'liveopsTriageConfig' },
        {
          settingName: 'liveopsTriageConfig',
          settingValue: validatedConfig,
        },
        { upsert: true }
      );

      this.logger.info('Updated LiveOps Triage configuration');
    } catch (error) {
      this.logger.error('Error updating LiveOps Triage config:', error);
      throw new Error('Failed to update LiveOps Triage configuration');
    }
  }

  /**
   * Fetch alerts from Slack channel using time-windowed pagination.
   *
   * Uses Slack's oldest/latest parameters with cursor-based pagination to fetch
   * ALL messages in the lookback window, preventing alert loss on high-volume channels.
   */
  async fetchSlackAlerts(channelId: string, lookbackHours: number): Promise<SlackAlert[]> {
    if (!this.slackClient) {
      throw new Error('Slack client not initialized');
    }

    // Calculate time window as Unix timestamps in seconds (Slack API format)
    const now = Date.now() / 1000;
    const oldest = (now - lookbackHours * 60 * 60).toString();
    const latest = now.toString();

    // Fetch ALL messages in time window with pagination (matches /liveops-triage skill)
    const messages = await this.slackClient.fetchChannelHistoryInTimeWindow(channelId, oldest, latest);

    // Transform to alerts (no client-side time filtering needed - API did it)
    const alerts: SlackAlert[] = messages.map((msg: SlackMessage) => ({
      ts: msg.ts,
      text: sanitizeErrorMessage(msg.text),
      timestamp: new Date(parseFloat(msg.ts) * 1000),
    }));

    this.logger.info(`Fetched ${alerts.length} alerts from last ${lookbackHours} hours`);
    return alerts;
  }

  /**
   * Fetch existing GitHub issues for deduplication
   */
  async fetchExistingIssues(repoFullName: string): Promise<ExistingIssue[]> {
    if (!this.githubService) {
      throw new Error('GitHub service not initialized');
    }

    try {
      // Fetch open issues with liveops label using GitHubService.searchIssues()
      const issues = await this.githubService.searchIssues(repoFullName, 'is:issue is:open label:liveops');

      const existingIssues: ExistingIssue[] = issues.map(issue => {
        // Extract fingerprints from issue body if present
        const fingerprint = extractFingerprintFromIssueBody(issue.body);
        const semanticFingerprint = extractSemanticFingerprintFromIssueBody(issue.body);

        return {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          labels: issue.labels.map(l => l.name),
          createdAt: issue.created_at,
          body: issue.body ?? undefined,
          fingerprint,
          semanticFingerprint,
        };
      });

      // Log fingerprint statistics
      const withFingerprint = existingIssues.filter(i => i.fingerprint).length;
      const withSemanticFingerprint = existingIssues.filter(i => i.semanticFingerprint).length;
      if (existingIssues.length === 0) {
        // Warn about potential whitelist issues - empty results could mean:
        // 1. No liveops issues exist (expected scenario)
        // 2. Repository not in GitHub connection whitelist (misconfiguration)
        this.logger.warn(
          'fetchExistingIssues returned empty - deduplication may not work if repo is not in whitelist',
          { repoFullName }
        );
      } else {
        this.logger.info(
          `Found ${existingIssues.length} existing liveops issues (${withFingerprint} with fingerprints, ${withSemanticFingerprint} with semantic fingerprints)`
        );
      }
      return existingIssues;
    } catch (error) {
      this.logger.error('Error fetching existing issues:', error);
      return [];
    }
  }

  /**
   * Fetch recently closed GitHub issues for regression detection
   * @param repoFullName - Full repo name (owner/repo)
   * @param lookbackDays - Number of days to look back for closed issues
   */
  async fetchRecentlyClosedIssues(repoFullName: string, lookbackDays: number): Promise<ExistingIssue[]> {
    if (!this.githubService) {
      throw new Error('GitHub service not initialized');
    }

    try {
      // Calculate the date threshold for recently closed issues
      const lookbackDate = new Date();
      lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);
      const dateStr = lookbackDate.toISOString().split('T')[0]; // YYYY-MM-DD format

      // Fetch closed issues with liveops label that were closed within the lookback period
      const query = `is:issue is:closed label:liveops closed:>${dateStr}`;
      const issues = await this.githubService.searchIssues(repoFullName, query);

      const closedIssues: ExistingIssue[] = issues.map(issue => {
        // Extract fingerprints from issue body if present
        const fingerprint = extractFingerprintFromIssueBody(issue.body);
        const semanticFingerprint = extractSemanticFingerprintFromIssueBody(issue.body);

        return {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          labels: issue.labels.map(l => l.name),
          createdAt: issue.created_at,
          body: issue.body ?? undefined,
          fingerprint,
          semanticFingerprint,
          // Use actual closed_at from GitHub API, fall back to updated_at if unavailable
          closedAt: issue.closed_at ?? issue.updated_at,
        };
      });

      // Log fingerprint statistics
      const withFingerprint = closedIssues.filter(i => i.fingerprint).length;
      const withSemanticFingerprint = closedIssues.filter(i => i.semanticFingerprint).length;
      if (closedIssues.length > 0) {
        this.logger.info(
          `Found ${closedIssues.length} recently closed liveops issues (last ${lookbackDays} days, ${withFingerprint} with fingerprints, ${withSemanticFingerprint} with semantic fingerprints)`
        );
      }
      return closedIssues;
    } catch (error) {
      this.logger.error('Error fetching recently closed issues:', error);
      return [];
    }
  }

  /**
   * Triage alerts using LLM
   */
  async triageAlertsWithLLM(
    alerts: SlackAlert[],
    existingIssues: ExistingIssue[],
    recentlyClosedIssues: ExistingIssue[],
    config: LiveopsTriageConfig
  ): Promise<LLMTriageResponse> {
    // Get API keys for system
    const dbAdapters = {
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      getSettingsByNames,
    };
    const coreKeys = await apiKeyService.getEffectiveLLMApiKeys('system', dbAdapters);
    const apiKeyTable = {
      openai: coreKeys.openai || undefined,
      anthropic: coreKeys.anthropic || undefined,
      gemini: coreKeys.gemini || undefined,
      bfl: coreKeys.bfl || undefined,
      ollama: coreKeys.ollama || undefined,
      xai: coreKeys.xai || undefined,
    };

    // Resolve any deprecated model ID stored in config before looking it up
    const resolvedModelId = resolveDeprecatedModelId(config.modelId, 'liveopsTriageService');

    // Get model info
    const availableModels = await getAvailableModels(apiKeyTable);
    const modelInfo = availableModels.find(m => m.id === resolvedModelId);

    if (!modelInfo) {
      throw new Error(`Configured model ${resolvedModelId} not available (original: ${config.modelId})`);
    }

    // Initialize LLM
    const llm = getLlmByModel(apiKeyTable, {
      modelInfo,
      logger: this.logger,
    });

    if (!llm) {
      throw new Error(`Failed to initialize LLM for model ${config.modelId}`);
    }

    // Build prompt
    const template = config.promptTemplate || getDefaultTemplateString();
    const repoName = `${config.githubOwner}/${config.githubRepo}`;

    const alertsJson = JSON.stringify(
      alerts.map(a => ({
        id: a.ts,
        text: a.text,
        timestamp: a.timestamp.toISOString(),
      })),
      null,
      2
    );

    const existingIssuesText =
      existingIssues.length > 0
        ? existingIssues.map(formatIssueForPrompt).join('\n')
        : 'No existing liveops issues found.';

    const recentlyClosedIssuesText =
      recentlyClosedIssues.length > 0
        ? recentlyClosedIssues.map(formatIssueForPrompt).join('\n')
        : 'No recently closed liveops issues found.';

    const prompt = interpolateTemplate(template, {
      alerts: alertsJson,
      existingIssues: existingIssuesText,
      recentlyClosedIssues: recentlyClosedIssuesText,
      priorityGuidelines: PRIORITY_GUIDELINES,
      repoName,
    });

    this.logger.info('Calling LLM for triage', {
      modelId: config.modelId,
      alertCount: alerts.length,
      promptLength: prompt.length,
    });

    // Call LLM
    let responseText = '';
    const messages = [{ role: 'user' as const, content: prompt }];

    const llmOptions = {
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      stream: false,
      thinking: { enabled: false, budget_tokens: 0 },
    };

    try {
      await Promise.race([
        llm.complete(
          config.modelId,
          messages,
          {
            ...llmOptions,
            // Disable thinking mode to ensure clean JSON output - Claude 4.5+ models
            // auto-enable thinking which forces temperature=1 and consumes output tokens
          },
          async texts => {
            // Concatenate all response chunks with size limit check
            if (texts && texts.length > 0) {
              const chunk = texts.join('');
              if (responseText.length + chunk.length > MAX_RESPONSE_SIZE) {
                throw new LLMError(
                  'SIZE_LIMIT',
                  `LLM response exceeded maximum size limit of ${MAX_RESPONSE_SIZE} bytes`
                );
              }
              responseText += chunk;
            }
          }
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new LLMError('TIMEOUT', `LLM call timed out after ${config.timeoutMs}ms`)),
            config.timeoutMs
          )
        ),
      ]);
    } catch (error) {
      // Categorize and log the error appropriately
      if (error instanceof LLMError) {
        this.logger.error(`LLM ${error.category} error:`, { message: error.message, category: error.category });
        throw error;
      }

      // Categorize API errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      const sanitizedMessage = sanitizeErrorMessage(errorMessage);

      // Detect rate limiting
      if (errorMessage.includes('rate limit') || errorMessage.includes('429') || errorMessage.includes('quota')) {
        this.logger.error('LLM rate limit error:', { message: sanitizedMessage });
        throw new LLMError('RATE_LIMIT', 'LLM API rate limit exceeded. Please try again later.');
      }

      // Detect authentication errors
      if (errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('invalid api key')) {
        this.logger.error('LLM authentication error:', { message: sanitizedMessage });
        throw new LLMError('AUTH_ERROR', 'LLM API authentication failed. Check API key configuration.');
      }

      // Detect service unavailability
      if (errorMessage.includes('503') || errorMessage.includes('502') || errorMessage.includes('unavailable')) {
        this.logger.error('LLM service unavailable:', { message: sanitizedMessage });
        throw new LLMError('SERVICE_UNAVAILABLE', 'LLM service temporarily unavailable. Please try again later.');
      }

      // Generic API error
      this.logger.error('LLM API error:', { message: sanitizedMessage });
      throw new LLMError('API_ERROR', `LLM API call failed: ${sanitizedMessage}`);
    }

    // Parse JSON response - extract from delimiters with fallbacks
    let jsonStr = responseText;

    // Try new unique delimiters first (preferred)
    const uniqueMatch = responseText.match(/<<<B4M_JSON_START>>>\s*([\s\S]*?)\s*<<<B4M_JSON_END>>>/);
    if (uniqueMatch) {
      jsonStr = uniqueMatch[1].trim();
    } else {
      // Fallback to markdown code blocks for backwards compatibility
      // Non-greedy to stop at first closing fence (original behavior)
      const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }
      // If neither found, try parsing raw response as last resort
      // (jsonStr remains as responseText)
    }

    try {
      const parsed = JSON.parse(jsonStr);

      // Validate with Zod schema (provides defaults for optional fields)
      const validationResult = LLMTriageResponseSchema.safeParse(parsed);
      if (!validationResult.success) {
        const validationErrors = validationResult.error.issues.map(
          issue => `${issue.path.join('.')}: ${issue.message}`
        );
        this.logger.error('LLM response validation failed:', {
          errors: validationErrors,
          jsonStrLength: jsonStr.length,
        });
        throw new LLMError('PARSE_ERROR', `LLM response validation failed: ${validationErrors.join('; ')}`);
      }

      const response = validationResult.data;

      // Log estimated cost
      const inputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
      const outputTokens = Math.ceil(responseText.length / CHARS_PER_TOKEN);
      const estimatedCost = calculateLLMCost(resolvedModelId, inputTokens, outputTokens);
      this.logger.info('LLM triage complete', {
        inputTokens,
        outputTokens,
        estimatedCost: `$${estimatedCost.toFixed(4)}`,
        triageResults: response.triageResults.length,
      });

      return response;
    } catch (parseError) {
      // Re-throw LLMError as-is
      if (parseError instanceof LLMError) {
        throw parseError;
      }
      const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
      this.logger.error('Failed to parse LLM response:', {
        error: errorMsg,
        jsonStrLength: jsonStr.length,
      });
      throw new LLMError('PARSE_ERROR', 'Failed to parse LLM triage response as JSON');
    }
  }

  /**
   * Create GitHub issue
   */
  async createGitHubIssue(repoFullName: string, triageResult: TriageResult): Promise<number | null> {
    if (!this.githubService) {
      throw new Error('GitHub service not initialized');
    }

    try {
      // Priority label colors
      const priorityColors: Record<string, string> = {
        P0: 'd73a4a', // red
        P1: 'ff7518', // orange
        P2: 'fbca04', // yellow
        P3: '0e8a16', // green
      };

      // Ensure liveops label exists using GitHubService
      const liveopsLabel = await this.githubService.ensureLabelExists(repoFullName, {
        name: 'liveops',
        color: 'f9d0c4',
        description: 'Automated LiveOps triage',
      });

      if (!liveopsLabel) {
        this.logger.error('[LIVEOPS-TRIAGE] Failed to ensure liveops label exists', {
          repoFullName,
          action: 'label_creation_failed',
          label: 'liveops',
          fix: 'Add repository to Allowed Repositories in Admin → GitHub settings',
        });
        return null;
      }

      // Ensure priority label exists
      const priorityLabel = await this.githubService.ensureLabelExists(repoFullName, {
        name: triageResult.priority,
        color: priorityColors[triageResult.priority] || 'ffffff',
        description: `Priority ${triageResult.priority}`,
      });

      if (!priorityLabel) {
        this.logger.error('[LIVEOPS-TRIAGE] Failed to ensure priority label exists', {
          repoFullName,
          action: 'label_creation_failed',
          label: triageResult.priority,
          fix: 'Add repository to Allowed Repositories in Admin → GitHub settings',
        });
        return null;
      }

      // Ensure bug label exists (commonly pre-existing, but safer to ensure with proper color)
      const bugLabel = await this.githubService.ensureLabelExists(repoFullName, {
        name: 'bug',
        color: 'd73a4a', // GitHub's default red for bugs
        description: "Something isn't working",
      });

      if (!bugLabel) {
        this.logger.error('[LIVEOPS-TRIAGE] Failed to ensure bug label exists', {
          repoFullName,
          action: 'label_creation_failed',
          label: 'bug',
          fix: 'Add repository to Allowed Repositories in Admin → GitHub settings',
        });
        return null;
      }

      // Ensure regression label exists if this is a regression
      if (triageResult.isRegression) {
        const regressionLabel = await this.githubService.ensureLabelExists(repoFullName, {
          name: 'regression',
          color: 'b60205', // Dark red for regressions
          description: 'Bug that reoccurred after being fixed',
        });

        if (!regressionLabel) {
          this.logger.error('[LIVEOPS-TRIAGE] Failed to ensure regression label exists', {
            repoFullName,
            action: 'label_creation_failed',
            label: 'regression',
            fix: 'Add repository to Allowed Repositories in Admin → GitHub settings',
          });
          return null;
        }
      }

      // Build labels array, adding 'regression' label if this is a regression
      const labels = ['bug', 'liveops', triageResult.priority];
      if (triageResult.isRegression) {
        labels.push('regression');
      }

      // Create issue using GitHubService
      const issue = await this.githubService.createIssue(repoFullName, {
        title: `[LiveOps] ${triageResult.title}`,
        body: this.formatIssueBody(triageResult),
        labels,
      });

      if (!issue) {
        this.logger.error('Failed to create GitHub issue: GitHubService returned null');
        return null;
      }

      // Audit logging for SOC2 compliance
      this.logIssueCreationAudit(repoFullName, issue.number, triageResult);

      this.logger.info(`Created GitHub issue #${issue.number}`, {
        title: triageResult.title,
        priority: triageResult.priority,
        url: issue.html_url,
      });

      return issue.number;
    } catch (error) {
      this.logger.error('Failed to create GitHub issue:', error);
      return null;
    }
  }

  /**
   * Audit logging for issue creation (SOC2 compliance)
   */
  private logIssueCreationAudit(repoFullName: string, issueNumber: number, triageResult: TriageResult): void {
    this.logger.info('[LIVEOPS-TRIAGE-AUDIT] Issue created', {
      action: 'issue_created',
      repo: repoFullName,
      issueNumber,
      priority: triageResult.priority,
      category: triageResult.category,
      title: triageResult.title,
      isRecurring: triageResult.isRecurring,
      occurrenceCount: triageResult.occurrenceCount,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Format issue body for GitHub
   */
  private formatIssueBody(triageResult: TriageResult): string {
    const sections = [
      '## Error Details',
      '',
      triageResult.body,
      '',
      '---',
      '',
      '## Triage Information',
      '',
      `- **Priority:** ${triageResult.priority}`,
      `- **Category:** ${triageResult.category}`,
      `- **Recurring:** ${triageResult.isRecurring ? 'Yes' : 'No'}`,
      `- **Occurrence Count:** ${triageResult.occurrenceCount}`,
    ];

    // Add regression section if this is a regression
    if (triageResult.isRegression && triageResult.matchedClosedIssue) {
      // closedAt may be null/undefined (LLM is not given it and may omit it).
      // Guard against new Date(null) silently rendering "1/1/1970".
      const rawClosedAt = triageResult.matchedClosedIssue.closedAt;
      // Align the fallback copy with the Slack summary ("closed previously")
      // for the rare case where closedAt is still missing after enrichment.
      const closedDate = rawClosedAt ? `on ${new Date(rawClosedAt).toLocaleDateString()}` : 'previously';
      sections.push('');
      sections.push('---');
      sections.push('');
      sections.push('## ⚠️ Regression');
      sections.push('');
      sections.push(
        `This is a regression of #${triageResult.matchedClosedIssue.issueNumber} which was closed ${closedDate}.`
      );
    }

    sections.push('');
    sections.push('---');
    sections.push('');
    sections.push('_This issue was automatically created by the LiveOps Triage system._');

    // Add fingerprint comments for cross-batch deduplication
    if (triageResult.fingerprint) {
      sections.push('');
      sections.push(formatFingerprintComment(triageResult.fingerprint));
    }
    if (triageResult.semanticFingerprint) {
      sections.push(formatSemanticFingerprintComment(triageResult.semanticFingerprint));
    }

    return sections.join('\n');
  }

  /**
   * Format the next scheduled run time for display in both CST and PHT timezones
   */
  private formatNextRun(nextRun: Date): string {
    const cst = nextRun.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    const pht = nextRun.toLocaleString('en-US', {
      timeZone: 'Asia/Manila',
      hour: 'numeric',
      minute: '2-digit',
    });
    return `${cst} CST (${pht} PHT)`;
  }

  /**
   * Build fingerprint indexes for open and closed issues
   * Used for efficient fingerprint-based deduplication and regression detection
   * Includes both exact fingerprints and semantic fingerprints for fallback matching
   */
  private buildFingerprintIndexes(
    existingIssues: ExistingIssue[],
    recentlyClosedIssues: ExistingIssue[]
  ): {
    openIssuesByFingerprint: Map<string, ExistingIssue>;
    closedIssuesByFingerprint: Map<string, ExistingIssue>;
    openIssuesBySemanticFingerprint: Map<string, ExistingIssue>;
    closedIssuesBySemanticFingerprint: Map<string, ExistingIssue>;
  } {
    const openIssuesByFingerprint = new Map<string, ExistingIssue>();
    const closedIssuesByFingerprint = new Map<string, ExistingIssue>();
    const openIssuesBySemanticFingerprint = new Map<string, ExistingIssue>();
    const closedIssuesBySemanticFingerprint = new Map<string, ExistingIssue>();

    for (const issue of existingIssues) {
      if (issue.fingerprint) {
        openIssuesByFingerprint.set(issue.fingerprint, issue);
      }
      if (issue.semanticFingerprint) {
        openIssuesBySemanticFingerprint.set(issue.semanticFingerprint, issue);
      }
    }
    for (const issue of recentlyClosedIssues) {
      if (issue.fingerprint) {
        closedIssuesByFingerprint.set(issue.fingerprint, issue);
      }
      if (issue.semanticFingerprint) {
        closedIssuesBySemanticFingerprint.set(issue.semanticFingerprint, issue);
      }
    }

    return {
      openIssuesByFingerprint,
      closedIssuesByFingerprint,
      openIssuesBySemanticFingerprint,
      closedIssuesBySemanticFingerprint,
    };
  }

  /**
   * Pre-match alerts against existing issues by fingerprint
   * Returns alerts that matched open issues (as TriageResults) and alerts needing LLM triage
   *
   * Match precedence:
   * 1. Exact fingerprint match (highest confidence)
   * 2. Semantic fingerprint match (high confidence - more aggressive normalization)
   * 3. Falls through to LLM triage
   */
  private preMatchAlertsByFingerprint(
    alertsByFingerprint: Map<string, Array<{ alert: SlackAlert; fingerprint: string }>>,
    alertsWithoutFingerprint: Array<{ alert: SlackAlert; fingerprint: string | null }>,
    openIssuesByFingerprint: Map<string, ExistingIssue>,
    closedIssuesByFingerprint: Map<string, ExistingIssue>,
    openIssuesBySemanticFingerprint: Map<string, ExistingIssue>,
    closedIssuesBySemanticFingerprint: Map<string, ExistingIssue>,
    options: { enableAuditLogs?: boolean; regressionGracePeriodHours?: number } = {}
  ): {
    preMatchedResults: TriageResult[];
    alertsNeedingLLM: SlackAlert[];
    fingerprintToAlerts: Map<string, SlackAlert[]>;
  } {
    const preMatchedResults: TriageResult[] = [];
    const alertsNeedingLLM: SlackAlert[] = [];
    const fingerprintToAlerts = new Map<string, SlackAlert[]>();
    const { enableAuditLogs = false, regressionGracePeriodHours = DEFAULT_REGRESSION_GRACE_PERIOD_HOURS } = options;
    const gracePeriodMs = regressionGracePeriodHours * 60 * 60 * 1000;

    for (const [fingerprint, group] of alertsByFingerprint.entries()) {
      const representativeAlert = group[0].alert;
      const occurrenceCount = group.length;

      // Check for exact fingerprint match against OPEN issues
      const matchedOpenIssue = openIssuesByFingerprint.get(fingerprint);
      if (matchedOpenIssue) {
        if (enableAuditLogs) {
          this.logger.info('[LIVEOPS-TRIAGE-AUDIT] Fingerprint match: alert matches open issue', {
            fingerprint: fingerprint.slice(0, 8),
            alertTs: representativeAlert.ts,
            matchedIssue: matchedOpenIssue.number,
          });
        }

        preMatchedResults.push({
          alertId: representativeAlert.ts,
          priority: 'P3', // Placeholder - actual priority comes from existing issue
          category: 'other',
          title: matchedOpenIssue.title.replace('[LiveOps] ', ''),
          body: `Matched existing issue #${matchedOpenIssue.number} by fingerprint`,
          labels: matchedOpenIssue.labels,
          matchesExisting: {
            issueNumber: matchedOpenIssue.number,
            title: matchedOpenIssue.title,
            state: 'open',
          },
          isRecurring: occurrenceCount > 1,
          occurrenceCount,
          isRegression: false,
          fingerprint,
        });
        continue;
      }

      // Check for fingerprint match against CLOSED issues (regression detection)
      const matchedClosedIssue = closedIssuesByFingerprint.get(fingerprint);
      if (matchedClosedIssue && matchedClosedIssue.closedAt) {
        const closedAt = new Date(matchedClosedIssue.closedAt).getTime();
        const now = Date.now();

        if (now - closedAt > gracePeriodMs) {
          // Issue closed > grace period - flag as potential regression, send to LLM
          if (enableAuditLogs) {
            this.logger.info('[LIVEOPS-TRIAGE-AUDIT] Fingerprint regression: alert matches closed issue', {
              fingerprint: fingerprint.slice(0, 8),
              alertTs: representativeAlert.ts,
              matchedIssue: matchedClosedIssue.number,
              closedAt: matchedClosedIssue.closedAt,
            });
          }

          // Add to alerts needing LLM but will be flagged as regression later
          alertsNeedingLLM.push(representativeAlert);
          fingerprintToAlerts.set(
            fingerprint,
            group.map(g => g.alert)
          );
          continue;
        } else {
          // Issue closed within grace period - treat as duplicate (likely old alert for a fixed issue)
          if (enableAuditLogs) {
            this.logger.info('[LIVEOPS-TRIAGE-AUDIT] Grace period skip: alert matches recently closed issue', {
              fingerprint: fingerprint.slice(0, 8),
              alertTs: representativeAlert.ts,
              matchedIssue: matchedClosedIssue.number,
              closedAt: matchedClosedIssue.closedAt,
              gracePeriodHours: regressionGracePeriodHours,
            });
          }

          preMatchedResults.push({
            alertId: representativeAlert.ts,
            priority: 'P3',
            category: 'other',
            title: matchedClosedIssue.title.replace('[LiveOps] ', ''),
            body: `Matched recently closed issue #${matchedClosedIssue.number} (within ${regressionGracePeriodHours}h grace period)`,
            labels: matchedClosedIssue.labels,
            matchesExisting: {
              issueNumber: matchedClosedIssue.number,
              title: matchedClosedIssue.title,
              state: 'closed',
            },
            isRecurring: occurrenceCount > 1,
            occurrenceCount,
            isRegression: false,
            fingerprint,
          });
          continue;
        }
      }

      // === TIER 2: Semantic fingerprint match (more aggressive normalization) ===
      const semanticFp = generateSemanticFingerprint(representativeAlert);
      if (semanticFp) {
        // Check semantic match against OPEN issues
        const semanticMatchedOpenIssue = openIssuesBySemanticFingerprint.get(semanticFp);
        if (semanticMatchedOpenIssue) {
          if (enableAuditLogs) {
            this.logger.info('[LIVEOPS-TRIAGE-AUDIT] Semantic fingerprint match: alert matches open issue', {
              exactFingerprint: fingerprint.slice(0, 8),
              semanticFingerprint: semanticFp.slice(0, 8),
              alertTs: representativeAlert.ts,
              matchedIssue: semanticMatchedOpenIssue.number,
            });
          }

          preMatchedResults.push({
            alertId: representativeAlert.ts,
            priority: 'P3',
            category: 'other',
            title: semanticMatchedOpenIssue.title.replace('[LiveOps] ', ''),
            body: `Matched existing issue #${semanticMatchedOpenIssue.number} by semantic fingerprint`,
            labels: semanticMatchedOpenIssue.labels,
            matchesExisting: {
              issueNumber: semanticMatchedOpenIssue.number,
              title: semanticMatchedOpenIssue.title,
              state: 'open',
            },
            isRecurring: occurrenceCount > 1,
            occurrenceCount,
            isRegression: false,
            fingerprint,
          });
          continue;
        }

        // Check semantic match against CLOSED issues (regression detection)
        const semanticMatchedClosedIssue = closedIssuesBySemanticFingerprint.get(semanticFp);
        if (semanticMatchedClosedIssue && semanticMatchedClosedIssue.closedAt) {
          const closedAt = new Date(semanticMatchedClosedIssue.closedAt).getTime();
          const now = Date.now();

          if (now - closedAt > gracePeriodMs) {
            // Issue closed > grace period - flag as potential regression, send to LLM
            if (enableAuditLogs) {
              this.logger.info('[LIVEOPS-TRIAGE-AUDIT] Semantic fingerprint regression: alert matches closed issue', {
                exactFingerprint: fingerprint.slice(0, 8),
                semanticFingerprint: semanticFp.slice(0, 8),
                alertTs: representativeAlert.ts,
                matchedIssue: semanticMatchedClosedIssue.number,
                closedAt: semanticMatchedClosedIssue.closedAt,
              });
            }

            // Add to alerts needing LLM but will be flagged as regression later
            alertsNeedingLLM.push(representativeAlert);
            fingerprintToAlerts.set(
              fingerprint,
              group.map(g => g.alert)
            );
            continue;
          } else {
            // Issue closed within grace period - treat as duplicate
            if (enableAuditLogs) {
              this.logger.info(
                '[LIVEOPS-TRIAGE-AUDIT] Semantic fingerprint grace period skip: alert matches recently closed issue',
                {
                  exactFingerprint: fingerprint.slice(0, 8),
                  semanticFingerprint: semanticFp.slice(0, 8),
                  alertTs: representativeAlert.ts,
                  matchedIssue: semanticMatchedClosedIssue.number,
                  closedAt: semanticMatchedClosedIssue.closedAt,
                  gracePeriodHours: regressionGracePeriodHours,
                }
              );
            }

            preMatchedResults.push({
              alertId: representativeAlert.ts,
              priority: 'P3',
              category: 'other',
              title: semanticMatchedClosedIssue.title.replace('[LiveOps] ', ''),
              body: `Matched recently closed issue #${semanticMatchedClosedIssue.number} by semantic fingerprint (within ${regressionGracePeriodHours}h grace period)`,
              labels: semanticMatchedClosedIssue.labels,
              matchesExisting: {
                issueNumber: semanticMatchedClosedIssue.number,
                title: semanticMatchedClosedIssue.title,
                state: 'closed',
              },
              isRecurring: occurrenceCount > 1,
              occurrenceCount,
              isRegression: false,
              fingerprint,
            });
            continue;
          }
        }
      }

      // No fingerprint match (exact or semantic) - needs LLM triage
      alertsNeedingLLM.push(representativeAlert);
      fingerprintToAlerts.set(
        fingerprint,
        group.map(g => g.alert)
      );
    }

    // Add alerts without fingerprints to LLM queue
    for (const alertWithFp of alertsWithoutFingerprint) {
      alertsNeedingLLM.push(alertWithFp.alert);
    }

    return { preMatchedResults, alertsNeedingLLM, fingerprintToAlerts };
  }

  /**
   * Post-LLM title matching - catches duplicates that fingerprint + LLM missed
   * Only matches if error types are compatible (e.g., both TypeError or both have UnknownError)
   *
   * This is a fallback mechanism per industry best practices (Sentry, Rollbar) that
   * uses title similarity matching to catch duplicates when fingerprints differ.
   *
   * @param triageResults - Results from LLM triage to potentially update
   * @param allIssues - Combined open and recently closed issues
   * @param options - Configuration options
   */
  private postMatchByTitle(
    triageResults: TriageResult[],
    allIssues: ExistingIssue[],
    options: {
      enableAuditLogs?: boolean;
      similarityThreshold?: number;
      minTitleLength?: number;
      regressionGracePeriodHours?: number;
    } = {}
  ): void {
    const {
      enableAuditLogs = false,
      similarityThreshold = 0.9,
      minTitleLength = 40,
      regressionGracePeriodHours = DEFAULT_REGRESSION_GRACE_PERIOD_HOURS,
    } = options;
    const gracePeriodMs = regressionGracePeriodHours * 60 * 60 * 1000;

    for (const result of triageResults) {
      // Skip if already matched by fingerprint
      if (result.matchesExisting) continue;

      // Extract error type from proposed title for validation
      const proposedErrorType = extractErrorType(result.title);

      // Filter issues to same error type before matching (prevents false positives)
      const compatibleIssues: TitleMatchIssue[] = allIssues
        .filter(issue => {
          const issueErrorType = extractErrorType(issue.title);
          // Match if either has UnknownError (wildcard) or both have same error type
          return (
            issueErrorType === proposedErrorType ||
            issueErrorType === 'UnknownError' ||
            proposedErrorType === 'UnknownError'
          );
        })
        .map(issue => ({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          closedAt: issue.closedAt,
        }));

      const titleMatch = findBestTitleMatch(result.title, compatibleIssues, {
        threshold: similarityThreshold,
        minLength: minTitleLength,
      });

      if (titleMatch) {
        const { issue, similarity } = titleMatch;

        if (enableAuditLogs) {
          this.logger.info('[LIVEOPS-TRIAGE-AUDIT] Title match found', {
            proposedTitle: result.title,
            matchedTitle: issue.title,
            matchedIssue: issue.number,
            similarity: similarity.toFixed(3),
            state: issue.state,
          });
        }

        if (issue.state === 'open') {
          // Match to open issue - treat as duplicate
          result.matchesExisting = {
            issueNumber: issue.number,
            title: issue.title,
            state: 'open',
          };
        } else if (issue.closedAt) {
          // Match to closed issue - check for regression
          const closedAt = new Date(issue.closedAt).getTime();
          if (Date.now() - closedAt > gracePeriodMs) {
            // Past grace period - this is a regression
            result.isRegression = true;
            result.matchedClosedIssue = {
              issueNumber: issue.number,
              title: issue.title,
              closedAt: issue.closedAt,
            };
            // Add regression label if not present
            if (!result.labels.includes('regression')) {
              result.labels.push('regression');
            }
          } else {
            // Within grace period - treat as duplicate (recently fixed, may be stale alert)
            result.matchesExisting = {
              issueNumber: issue.number,
              title: issue.title,
              state: 'closed',
            };
          }
        }
      }
    }
  }

  /**
   * Post "no errors" message to Slack when no alerts found
   */
  async postNoErrorsMessage(channelId: string, lookbackHours: number, nextRun: Date): Promise<void> {
    if (!this.slackClient) {
      throw new Error('Slack client not initialized');
    }

    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '✅ LiveOps Triage Complete',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `No errors found in the last ${lookbackHours} hours.`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `_Next scheduled run: ${this.formatNextRun(nextRun)}_`,
          },
        ],
      },
    ];

    await this.slackClient.sendMessage({
      channel: channelId,
      text: `LiveOps Triage: No errors in the last ${lookbackHours} hours`,
      blocks,
    });

    this.logger.info('Posted no-errors message to Slack');
  }

  /**
   * Post triage summary to Slack
   */
  async postTriageSummary(
    channelId: string,
    summary: TriageSummary,
    createdIssues: Array<{
      number: number;
      title: string;
      priority: string;
      url: string;
      isRegression?: boolean;
      matchedClosedIssue?: { issueNumber: number; title: string; closedAt?: string | null } | null;
    }>,
    matchedExistingIssues: Array<{ issueNumber: number; title: string; priority: string; repoFullName: string }>,
    lookbackHours: number,
    nextScheduledRun: Date
  ): Promise<void> {
    if (!this.slackClient) {
      throw new Error('Slack client not initialized');
    }

    // Group created issues by priority
    const p0Issues = createdIssues.filter(i => i.priority === 'P0');
    const p1Issues = createdIssues.filter(i => i.priority === 'P1');
    const p2Issues = createdIssues.filter(i => i.priority === 'P2');
    const p3Issues = createdIssues.filter(i => i.priority === 'P3');

    // Get regression issues (separate from priority grouping)
    const regressionIssues = createdIssues.filter(i => i.isRegression && i.matchedClosedIssue);

    // Only @here for P0 (truly critical) - P1 issues don't warrant immediate team notification
    const hasCriticalIssues = p0Issues.length > 0;

    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'LiveOps Triage Summary',
          emoji: true,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `_Last ${lookbackHours} hours | ${summary.totalAlerts} alerts analyzed_`,
          },
        ],
      },
    ];

    // Add @here alert only for P0 (critical) issues
    if (hasCriticalIssues) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `<!here> *🔴 CRITICAL: ${p0Issues.length} P0 issue${p0Issues.length > 1 ? 's' : ''} require${p0Issues.length === 1 ? 's' : ''} immediate action*`,
        },
      });
    }

    blocks.push({
      type: 'divider',
    });

    // Helper to format issue links
    const formatCreatedIssue = (i: { number: number; title: string; priority: string; url: string }) =>
      `• <${i.url}|#${i.number}>: ${i.title}`;

    const formatMatchedIssue = (i: { issueNumber: number; title: string; repoFullName: string }) =>
      `• <https://github.com/${i.repoFullName}/issues/${i.issueNumber}|#${i.issueNumber}>: ${i.title}`;

    // P0 section (Critical)
    if (p0Issues.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*🔴 P0 Issues (Critical - Immediate Action)*',
        },
      });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: p0Issues.map(formatCreatedIssue).join('\n'),
        },
      });
    }

    // P1 section (High)
    if (p1Issues.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*🟠 P1 Issues (High Priority)*',
        },
      });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: p1Issues.map(formatCreatedIssue).join('\n'),
        },
      });
    }

    // P2 section (Medium)
    if (p2Issues.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*🟡 P2 Issues (Medium Priority)*',
        },
      });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: p2Issues.map(formatCreatedIssue).join('\n'),
        },
      });
    }

    // P3 section (Low)
    if (p3Issues.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*🟢 P3 Issues (Low Priority)*',
        },
      });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: p3Issues.map(formatCreatedIssue).join('\n'),
        },
      });
    }

    // Regressions section (Previously Fixed)
    if (regressionIssues.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*🔄 Regressions (Previously Fixed)*',
        },
      });
      const regressionLines = regressionIssues.map(i => {
        const rawClosedAt = i.matchedClosedIssue!.closedAt;
        // closedAt may be null/undefined (LLM not given it); avoid new Date(null) -> NaN days.
        const closedNote = rawClosedAt
          ? `closed ${Math.floor((Date.now() - new Date(rawClosedAt).getTime()) / (1000 * 60 * 60 * 24))} days ago`
          : 'closed previously';
        return `• <${i.url}|#${i.number}>: ${i.title}\n  ↳ Was #${i.matchedClosedIssue!.issueNumber} (${closedNote})`;
      });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: regressionLines.join('\n'),
        },
      });
    }

    // Matched existing issues section
    if (matchedExistingIssues.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*🔗 Matched Existing Issues (Duplicates)*',
        },
      });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: matchedExistingIssues.map(formatMatchedIssue).join('\n'),
        },
      });
    }

    // Stats section - compact context block with separate elements for mobile-friendly wrapping
    // Use actual array lengths instead of LLM summary counts to ensure consistency with displayed issues
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `*New:* ${createdIssues.length}` },
        { type: 'mrkdwn', text: `*Dupes:* ${matchedExistingIssues.length}` },
        { type: 'mrkdwn', text: `*Regs:* ${regressionIssues.length}` },
        { type: 'mrkdwn', text: `🔴 ${p0Issues.length}` },
        { type: 'mrkdwn', text: `🟠 ${p1Issues.length}` },
        { type: 'mrkdwn', text: `🟡 ${p2Issues.length}` },
        { type: 'mrkdwn', text: `🟢 ${p3Issues.length}` },
      ],
    });

    // Health assessment
    if (summary.healthAssessment) {
      blocks.push({
        type: 'divider',
      });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Health Assessment:*\n${summary.healthAssessment}`,
        },
      });
    }

    // Footer with next scheduled run
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_Next scheduled run: ${this.formatNextRun(nextScheduledRun)}_`,
        },
      ],
    });

    // Fallback text for notifications (no @here - it's in the blocks)
    const fallbackText = hasCriticalIssues
      ? `CRITICAL: ${p0Issues.length} P0 issues - LiveOps Triage Summary`
      : `LiveOps Triage Summary: ${createdIssues.length} new issues`;

    await this.slackClient.sendMessage({
      channel: channelId,
      text: fallbackText,
      blocks,
    });

    this.logger.info('Posted triage summary to Slack');
  }

  /**
   * Run the full triage process
   * @param slackBotToken - Slack bot token for API access
   * @param githubService - GitHub service instance
   * @param options - Optional settings
   * @param options.bypassEnabledCheck - Skip the enabled check (for manual runs)
   * @param options.lookbackHours - Override the configured lookback period
   */
  async runTriage(
    slackBotToken: string,
    githubService: GitHubService,
    options?: { bypassEnabledCheck?: boolean; lookbackHours?: number }
  ): Promise<TriageRunResult> {
    const config = await this.getConfig();

    // Use provided lookbackHours or fall back to config interval
    const effectiveLookbackHours = options?.lookbackHours ?? config.runIntervalHours;

    // Only check enabled flag for scheduled runs (cron), not manual runs
    if (!config.enabled && !options?.bypassEnabledCheck) {
      this.logger.info('LiveOps Triage is disabled');
      return {
        status: 'success',
        errorsProcessed: 0,
        issuesCreated: [],
        issuesDeduplicated: 0,
        p0Issues: [],
        p1Issues: [],
      };
    }

    // Initialize clients
    await this.initSlackClient(slackBotToken);
    this.initGitHubService(githubService);

    try {
      // Fetch alerts using effective lookback hours
      const alerts = await this.fetchSlackAlerts(config.slackChannelId, effectiveLookbackHours);

      if (alerts.length === 0) {
        this.logger.info('No alerts found in the lookback period');

        // Post "all clear" message if enabled
        if (config.postWhenNoErrors) {
          const nextRun = getNextScheduledRun(config.runIntervalHours ?? 12);
          const outputChannelId = config.slackOutputChannelId || config.slackChannelId;
          await this.postNoErrorsMessage(outputChannelId, effectiveLookbackHours, nextRun);
        }

        return {
          status: 'success',
          errorsProcessed: 0,
          issuesCreated: [],
          issuesDeduplicated: 0,
          p0Issues: [],
          p1Issues: [],
        };
      }

      // Limit alerts to process
      const alertsToProcess = alerts.slice(0, config.maxErrorsPerRun);

      // Fetch existing issues (open and recently closed for regression detection)
      const repoFullName = `${config.githubOwner}/${config.githubRepo}`;
      const existingIssues = await this.fetchExistingIssues(repoFullName);
      const recentlyClosedIssues = await this.fetchRecentlyClosedIssues(
        repoFullName,
        config.regressionLookbackDays ?? LIVEOPS_TRIAGE_VALIDATION_LIMITS.regressionLookbackDays.default
      );

      // === STEP 1: Generate fingerprints and pre-group alerts ===
      const alertsWithFingerprints = alertsToProcess.map(alert => ({
        alert,
        fingerprint: generateFingerprint(alert),
      }));

      // Group alerts by fingerprint for intra-batch deduplication
      const alertsByFingerprint = new Map<string, Array<{ alert: SlackAlert; fingerprint: string | null }>>();
      const alertsWithoutFingerprint: Array<{ alert: SlackAlert; fingerprint: string | null }> = [];

      for (const alertWithFp of alertsWithFingerprints) {
        if (alertWithFp.fingerprint) {
          const group = alertsByFingerprint.get(alertWithFp.fingerprint) || [];
          group.push(alertWithFp);
          alertsByFingerprint.set(alertWithFp.fingerprint, group);
        } else {
          alertsWithoutFingerprint.push(alertWithFp);
        }
      }

      // Log fingerprint statistics
      this.logger.info('[LIVEOPS-METRICS] Fingerprint statistics', {
        totalAlerts: alertsToProcess.length,
        uniqueFingerprints: alertsByFingerprint.size,
        alertsWithoutFingerprint: alertsWithoutFingerprint.length,
        collisionRate:
          alertsByFingerprint.size > 0
            ? (
                ((alertsToProcess.length - alertsWithoutFingerprint.length - alertsByFingerprint.size) /
                  (alertsToProcess.length - alertsWithoutFingerprint.length)) *
                100
              ).toFixed(1) + '%'
            : 'N/A',
      });

      // === STEP 2: Build fingerprint index of existing issues ===
      const {
        openIssuesByFingerprint,
        closedIssuesByFingerprint,
        openIssuesBySemanticFingerprint,
        closedIssuesBySemanticFingerprint,
      } = this.buildFingerprintIndexes(existingIssues, recentlyClosedIssues);

      this.logger.info('[LIVEOPS-TRIAGE] Fingerprint index built', {
        openIssuesWithFingerprint: openIssuesByFingerprint.size,
        closedIssuesWithFingerprint: closedIssuesByFingerprint.size,
        openIssuesWithSemanticFingerprint: openIssuesBySemanticFingerprint.size,
        closedIssuesWithSemanticFingerprint: closedIssuesBySemanticFingerprint.size,
      });

      // === STEP 3: Pre-match alerts against existing issues by fingerprint ===
      const { preMatchedResults, alertsNeedingLLM, fingerprintToAlerts } = this.preMatchAlertsByFingerprint(
        alertsByFingerprint as Map<string, Array<{ alert: SlackAlert; fingerprint: string }>>,
        alertsWithoutFingerprint,
        openIssuesByFingerprint,
        closedIssuesByFingerprint,
        openIssuesBySemanticFingerprint,
        closedIssuesBySemanticFingerprint,
        { enableAuditLogs: true, regressionGracePeriodHours: config.regressionGracePeriodHours }
      );

      this.logger.info('[LIVEOPS-TRIAGE] Pre-matching complete', {
        preMatchedByFingerprint: preMatchedResults.length,
        alertsNeedingLLM: alertsNeedingLLM.length,
      });

      // === STEP 4: Triage remaining alerts with LLM ===
      let triageResponse: LLMTriageResponse;
      if (alertsNeedingLLM.length > 0) {
        triageResponse = await this.triageAlertsWithLLM(alertsNeedingLLM, existingIssues, recentlyClosedIssues, config);

        // Build alert ID -> fingerprint map for O(1) lookup (avoids O(n*m) nested loop)
        const alertIdToFingerprint = new Map<
          string,
          { fingerprint: string; semanticFingerprint: string | null; alertCount: number }
        >();
        for (const [fp, alerts] of fingerprintToAlerts.entries()) {
          for (const alert of alerts) {
            const semanticFp = generateSemanticFingerprint(alert);
            alertIdToFingerprint.set(alert.ts, {
              fingerprint: fp,
              semanticFingerprint: semanticFp,
              alertCount: alerts.length,
            });
          }
        }

        // Attach fingerprints to LLM results
        for (const result of triageResponse.triageResults) {
          // Find the fingerprint for this alert (O(1) lookup)
          const fpData = alertIdToFingerprint.get(result.alertId);
          if (fpData) {
            result.fingerprint = fpData.fingerprint;
            result.semanticFingerprint = fpData.semanticFingerprint;
            // Update occurrence count based on pre-grouping
            if (fpData.alertCount > 1) {
              result.occurrenceCount = fpData.alertCount;
              result.isRecurring = true;
            }
          }

          // Check if this alert matches a closed issue for regression (via fingerprint)
          if (result.fingerprint) {
            const matchedClosedIssue = closedIssuesByFingerprint.get(result.fingerprint);
            if (matchedClosedIssue && matchedClosedIssue.closedAt) {
              const closedAt = new Date(matchedClosedIssue.closedAt).getTime();
              const gracePeriodMs =
                (config.regressionGracePeriodHours ?? DEFAULT_REGRESSION_GRACE_PERIOD_HOURS) * 60 * 60 * 1000;
              if (Date.now() - closedAt > gracePeriodMs) {
                result.isRegression = true;
                result.matchedClosedIssue = {
                  issueNumber: matchedClosedIssue.number,
                  title: matchedClosedIssue.title,
                  closedAt: matchedClosedIssue.closedAt,
                };
              }
            }
          }

          // Also check if LLM matched against a closed issue (even without fingerprint match)
          checkLLMMatchedClosedIssueRegression(
            result,
            recentlyClosedIssues,
            config.regressionGracePeriodHours ?? DEFAULT_REGRESSION_GRACE_PERIOD_HOURS
          );
        }

        // === STEP 4.5: Post-LLM title matching (catches duplicates that fingerprint + LLM missed) ===
        const allIssuesForTitleMatch = [...existingIssues, ...recentlyClosedIssues];
        this.postMatchByTitle(triageResponse.triageResults, allIssuesForTitleMatch, {
          enableAuditLogs: true,
          similarityThreshold: 0.9,
          minTitleLength: 40,
          regressionGracePeriodHours: config.regressionGracePeriodHours ?? DEFAULT_REGRESSION_GRACE_PERIOD_HOURS,
        });

        this.logger.info('[LIVEOPS-TRIAGE] Post-LLM title matching complete', {
          titleMatchedCount: triageResponse.triageResults.filter(r => r.matchesExisting && !r.fingerprint).length,
        });

        // === STEP 5: Post-LLM validation - merge duplicates with same fingerprint ===
        const fingerprintToResult = new Map<string, TriageResult>();
        const duplicatesToRemove: number[] = [];

        for (let i = 0; i < triageResponse.triageResults.length; i++) {
          const result = triageResponse.triageResults[i];
          const fp = result.fingerprint;

          if (fp && fingerprintToResult.has(fp) && !result.matchesExisting) {
            // LLM created duplicate - merge with first result
            const existing = fingerprintToResult.get(fp)!;
            existing.occurrenceCount += result.occurrenceCount;
            duplicatesToRemove.push(i);

            this.logger.info('[LIVEOPS-TRIAGE] Post-validation merged duplicate', {
              fingerprint: fp.slice(0, 8),
              mergedInto: existing.title,
              removedTitle: result.title,
            });
          } else if (fp) {
            fingerprintToResult.set(fp, result);
          }
        }

        // Remove duplicates from results (iterate in reverse to preserve indices)
        for (const idx of duplicatesToRemove.reverse()) {
          triageResponse.triageResults.splice(idx, 1);
        }

        // Merge pre-matched results into the response
        triageResponse.triageResults.push(...preMatchedResults);
        triageResponse.summary.duplicates += preMatchedResults.length;
      } else {
        // All alerts were pre-matched by fingerprint
        triageResponse = {
          triageResults: preMatchedResults,
          summary: {
            totalAlerts: alertsToProcess.length,
            newIssues: 0,
            duplicates: preMatchedResults.length,
            regressions: 0,
            p0Count: 0,
            p1Count: 0,
            p2Count: 0,
            p3Count: 0,
            recurringPatterns: [],
            healthAssessment: 'All alerts matched existing issues by fingerprint.',
          },
        };
      }

      // Create GitHub issues and track matched existing issues
      const createdIssues: Array<{
        number: number;
        title: string;
        priority: string;
        url: string;
        isRegression?: boolean;
        matchedClosedIssue?: { issueNumber: number; title: string; closedAt?: string | null } | null;
      }> = [];
      const matchedExistingIssues: Array<{
        issueNumber: number;
        title: string;
        priority: string;
        repoFullName: string;
      }> = [];
      const p0Issues: number[] = [];
      const p1Issues: number[] = [];

      for (const result of triageResponse.triageResults) {
        // Track matched existing issues for Slack summary
        if (result.matchesExisting) {
          matchedExistingIssues.push({
            issueNumber: result.matchesExisting.issueNumber,
            title: result.matchesExisting.title,
            priority: result.priority,
            repoFullName,
          });

          // Audit log for deduplication (helps with debugging and compliance)
          this.logger.info('[LIVEOPS-TRIAGE-AUDIT] Issue deduplicated', {
            action: 'issue_deduplicated',
            repo: repoFullName,
            matchedIssue: result.matchesExisting,
            priority: result.priority,
            category: result.category,
            title: result.title,
            timestamp: new Date().toISOString(),
          });
          continue;
        }

        // Only create issues if auto-create is enabled
        if (config.autoCreateIssues) {
          const issueNumber = await this.createGitHubIssue(repoFullName, result);

          if (issueNumber) {
            createdIssues.push({
              number: issueNumber,
              title: result.title,
              priority: result.priority,
              url: `https://github.com/${repoFullName}/issues/${issueNumber}`,
              isRegression: result.isRegression,
              matchedClosedIssue: result.matchedClosedIssue,
            });

            if (result.priority === 'P0') {
              p0Issues.push(issueNumber);
            } else if (result.priority === 'P1') {
              p1Issues.push(issueNumber);
            }
          } else {
            // Issue creation failed - likely due to repo not in whitelist
            this.logger.warn('[LIVEOPS-TRIAGE] Issue creation failed - check repo whitelist', {
              action: 'issue_creation_failed',
              title: result.title,
              priority: result.priority,
              repo: repoFullName,
              hint: 'Ensure repo is in GitHub connection allowedRepositories list',
            });
          }
        }
      }

      // Post summary to Slack (use output channel if configured, otherwise source channel)
      const outputChannelId = config.slackOutputChannelId || config.slackChannelId;
      const nextScheduledRun = getNextScheduledRun(config.runIntervalHours ?? 12);
      await this.postTriageSummary(
        outputChannelId,
        triageResponse.summary,
        createdIssues,
        matchedExistingIssues,
        effectiveLookbackHours,
        nextScheduledRun
      );

      // Update last run info
      await this.updateConfig({
        ...config,
        lastRunAt: new Date().toISOString(),
        lastRunDate: new Date().toISOString().split('T')[0],
        lastRunResult: {
          status: 'success',
          errorsProcessed: alertsToProcess.length,
          issuesCreated: createdIssues.map(i => i.number),
          issuesDeduplicated: triageResponse.summary.duplicates,
        },
      });

      return {
        status: 'success',
        errorsProcessed: alertsToProcess.length,
        issuesCreated: createdIssues.map(i => i.number),
        issuesDeduplicated: triageResponse.summary.duplicates,
        p0Issues,
        p1Issues,
        summary: triageResponse.summary,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error('Triage run failed:', error);

      // Update last run with failure
      await this.updateConfig({
        ...config,
        lastRunAt: new Date().toISOString(),
        lastRunDate: new Date().toISOString().split('T')[0],
        lastRunResult: {
          status: 'failed',
          errorsProcessed: 0,
          issuesCreated: [],
          issuesDeduplicated: 0,
        },
      });

      return {
        status: 'failed',
        errorsProcessed: 0,
        issuesCreated: [],
        issuesDeduplicated: 0,
        p0Issues: [],
        p1Issues: [],
        error: errorMessage,
      };
    }
  }

  /**
   * Run a dry run of the triage process
   * Does everything except actually creating issues or posting to Slack
   * @param slackBotToken - Slack bot token for API access
   * @param githubService - GitHub service instance
   * @param options - Optional settings
   * @param options.lookbackHours - Override the configured lookback period
   */
  async runDryRun(
    slackBotToken: string,
    githubService: GitHubService,
    options?: { lookbackHours?: number }
  ): Promise<DryRunResult> {
    const config = await this.getConfig();
    const dryRunResolvedModelId = resolveDeprecatedModelId(config.modelId, 'liveopsTriageDryRun');

    // Use provided lookbackHours or fall back to config interval
    const effectiveLookbackHours = options?.lookbackHours ?? config.runIntervalHours;

    // Initialize clients
    await this.initSlackClient(slackBotToken);
    this.initGitHubService(githubService);

    try {
      // Fetch alerts using effective lookback hours
      const alerts = await this.fetchSlackAlerts(config.slackChannelId, effectiveLookbackHours);

      if (alerts.length === 0) {
        return {
          status: 'success',
          dryRun: true,
          lookbackHours: effectiveLookbackHours,
          alertsFetched: 0,
          alertsToProcess: 0,
          existingIssuesFound: 0,
          triageResults: [],
          summary: {
            totalAlerts: 0,
            newIssues: 0,
            duplicates: 0,
            regressions: 0,
            p0Count: 0,
            p1Count: 0,
            p2Count: 0,
            p3Count: 0,
            recurringPatterns: [],
            healthAssessment: 'No alerts found in the lookback period.',
          },
          issuesWouldCreate: [],
          issuesWouldSkip: [],
          llmDetails: {
            modelId: config.modelId,
            promptLength: 0,
            responseLength: 0,
            estimatedCost: '$0.0000',
          },
        };
      }

      // Limit alerts to process
      const alertsToProcess = alerts.slice(0, config.maxErrorsPerRun);

      // Fetch existing issues (open and recently closed for regression detection)
      const repoFullName = `${config.githubOwner}/${config.githubRepo}`;
      const existingIssues = await this.fetchExistingIssues(repoFullName);
      const recentlyClosedIssues = await this.fetchRecentlyClosedIssues(
        repoFullName,
        config.regressionLookbackDays ?? LIVEOPS_TRIAGE_VALIDATION_LIMITS.regressionLookbackDays.default
      );

      // Log dry run context for whitelist troubleshooting
      if (existingIssues.length === 0) {
        this.logger.warn(
          'Dry run: No existing issues found - deduplication preview may be incomplete if repo not in whitelist',
          {
            repoFullName,
            isDryRun: true,
          }
        );
      }

      // === DRY RUN: Generate fingerprints and pre-group alerts ===
      const alertsWithFingerprints = alertsToProcess.map(alert => ({
        alert,
        fingerprint: generateFingerprint(alert),
      }));

      // Group alerts by fingerprint for intra-batch deduplication
      const alertsByFingerprint = new Map<string, Array<{ alert: SlackAlert; fingerprint: string | null }>>();
      const alertsWithoutFingerprint: Array<{ alert: SlackAlert; fingerprint: string | null }> = [];

      for (const alertWithFp of alertsWithFingerprints) {
        if (alertWithFp.fingerprint) {
          const group = alertsByFingerprint.get(alertWithFp.fingerprint) || [];
          group.push(alertWithFp);
          alertsByFingerprint.set(alertWithFp.fingerprint, group);
        } else {
          alertsWithoutFingerprint.push(alertWithFp);
        }
      }

      // Build fingerprint index of existing issues
      const {
        openIssuesByFingerprint,
        closedIssuesByFingerprint,
        openIssuesBySemanticFingerprint,
        closedIssuesBySemanticFingerprint,
      } = this.buildFingerprintIndexes(existingIssues, recentlyClosedIssues);

      // Pre-match alerts against existing issues by fingerprint
      const { preMatchedResults, alertsNeedingLLM, fingerprintToAlerts } = this.preMatchAlertsByFingerprint(
        alertsByFingerprint as Map<string, Array<{ alert: SlackAlert; fingerprint: string }>>,
        alertsWithoutFingerprint,
        openIssuesByFingerprint,
        closedIssuesByFingerprint,
        openIssuesBySemanticFingerprint,
        closedIssuesBySemanticFingerprint,
        { enableAuditLogs: false, regressionGracePeriodHours: config.regressionGracePeriodHours } // Dry run doesn't need audit logs
      );

      // Build prompt for details
      const template = config.promptTemplate || getDefaultTemplateString();
      const repoName = repoFullName;
      const alertsJson = JSON.stringify(
        alertsNeedingLLM.map(a => ({
          id: a.ts,
          text: a.text,
          timestamp: a.timestamp.toISOString(),
        })),
        null,
        2
      );
      const existingIssuesText =
        existingIssues.length > 0
          ? existingIssues.map(formatIssueForPrompt).join('\n')
          : 'No existing liveops issues found.';
      const recentlyClosedIssuesText =
        recentlyClosedIssues.length > 0
          ? recentlyClosedIssues.map(formatIssueForPrompt).join('\n')
          : 'No recently closed liveops issues found.';
      const prompt = interpolateTemplate(template, {
        alerts: alertsJson,
        existingIssues: existingIssuesText,
        recentlyClosedIssues: recentlyClosedIssuesText,
        priorityGuidelines: PRIORITY_GUIDELINES,
        repoName,
      });

      // Triage remaining alerts with LLM
      let triageResponse: LLMTriageResponse;
      if (alertsNeedingLLM.length > 0) {
        triageResponse = await this.triageAlertsWithLLM(alertsNeedingLLM, existingIssues, recentlyClosedIssues, config);

        // Build alert ID -> fingerprint map for O(1) lookup (avoids O(n*m) nested loop)
        const alertIdToFingerprint = new Map<
          string,
          { fingerprint: string; semanticFingerprint: string | null; alertCount: number }
        >();
        for (const [fp, alerts] of fingerprintToAlerts.entries()) {
          for (const alert of alerts) {
            const semanticFp = generateSemanticFingerprint(alert);
            alertIdToFingerprint.set(alert.ts, {
              fingerprint: fp,
              semanticFingerprint: semanticFp,
              alertCount: alerts.length,
            });
          }
        }

        // Attach fingerprints to LLM results
        for (const result of triageResponse.triageResults) {
          const fpData = alertIdToFingerprint.get(result.alertId);
          if (fpData) {
            result.fingerprint = fpData.fingerprint;
            result.semanticFingerprint = fpData.semanticFingerprint;
            if (fpData.alertCount > 1) {
              result.occurrenceCount = fpData.alertCount;
              result.isRecurring = true;
            }

            // Check for regression (via fingerprint)
            const matchedClosedIssue = closedIssuesByFingerprint.get(fpData.fingerprint);
            if (matchedClosedIssue && matchedClosedIssue.closedAt) {
              const closedAt = new Date(matchedClosedIssue.closedAt).getTime();
              const gracePeriodMs =
                (config.regressionGracePeriodHours ?? DEFAULT_REGRESSION_GRACE_PERIOD_HOURS) * 60 * 60 * 1000;
              if (Date.now() - closedAt > gracePeriodMs) {
                result.isRegression = true;
                result.matchedClosedIssue = {
                  issueNumber: matchedClosedIssue.number,
                  title: matchedClosedIssue.title,
                  closedAt: matchedClosedIssue.closedAt,
                };
              }
            }
          }

          // Also check if LLM matched against a closed issue (even without fingerprint match)
          checkLLMMatchedClosedIssueRegression(
            result,
            recentlyClosedIssues,
            config.regressionGracePeriodHours ?? DEFAULT_REGRESSION_GRACE_PERIOD_HOURS
          );
        }

        // Post-LLM title matching (catches duplicates that fingerprint + LLM missed)
        const allIssuesForTitleMatchDryRun = [...existingIssues, ...recentlyClosedIssues];
        this.postMatchByTitle(triageResponse.triageResults, allIssuesForTitleMatchDryRun, {
          enableAuditLogs: false, // Less verbose for dry run
          similarityThreshold: 0.9,
          minTitleLength: 40,
          regressionGracePeriodHours: config.regressionGracePeriodHours ?? DEFAULT_REGRESSION_GRACE_PERIOD_HOURS,
        });

        // Merge pre-matched results
        triageResponse.triageResults.push(...preMatchedResults);
        triageResponse.summary.duplicates += preMatchedResults.length;
      } else {
        // All alerts pre-matched by fingerprint
        triageResponse = {
          triageResults: preMatchedResults,
          summary: {
            totalAlerts: alertsToProcess.length,
            newIssues: 0,
            duplicates: preMatchedResults.length,
            regressions: 0,
            p0Count: 0,
            p1Count: 0,
            p2Count: 0,
            p3Count: 0,
            recurringPatterns: [],
            healthAssessment: 'All alerts matched existing issues by fingerprint.',
          },
        };
      }

      // Separate issues that would be created vs skipped
      const issuesWouldCreate: DryRunResult['issuesWouldCreate'] = [];
      const issuesWouldSkip: DryRunResult['issuesWouldSkip'] = [];

      for (const result of triageResponse.triageResults) {
        if (result.matchesExisting) {
          issuesWouldSkip.push({
            title: result.title,
            priority: result.priority,
            matchesExisting: result.matchesExisting,
          });
        } else {
          issuesWouldCreate.push({
            title: `[LiveOps] ${result.title}`,
            priority: result.priority,
            category: result.category,
            body: this.formatIssueBody(result),
            labels: result.isRegression
              ? ['bug', 'liveops', result.priority, 'regression']
              : ['bug', 'liveops', result.priority],
            isRecurring: result.isRecurring,
            occurrenceCount: result.occurrenceCount,
            isRegression: result.isRegression,
          });
        }
      }

      // Calculate estimated cost
      const inputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
      // Estimate output tokens from response
      const outputTokens = Math.ceil(JSON.stringify(triageResponse).length / CHARS_PER_TOKEN);
      const estimatedCost = calculateLLMCost(dryRunResolvedModelId, inputTokens, outputTokens);

      return {
        status: 'success',
        dryRun: true,
        lookbackHours: effectiveLookbackHours,
        alertsFetched: alerts.length,
        alertsToProcess: alertsToProcess.length,
        existingIssuesFound: existingIssues.length,
        triageResults: triageResponse.triageResults,
        summary: triageResponse.summary,
        issuesWouldCreate,
        issuesWouldSkip,
        llmDetails: {
          modelId: config.modelId,
          promptLength: prompt.length,
          responseLength: JSON.stringify(triageResponse).length,
          estimatedCost: `$${estimatedCost.toFixed(4)}`,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Dry run failed:', error);

      return {
        status: 'failed',
        dryRun: true,
        lookbackHours: effectiveLookbackHours,
        alertsFetched: 0,
        alertsToProcess: 0,
        existingIssuesFound: 0,
        triageResults: [],
        summary: {
          totalAlerts: 0,
          newIssues: 0,
          duplicates: 0,
          regressions: 0,
          p0Count: 0,
          p1Count: 0,
          p2Count: 0,
          p3Count: 0,
          recurringPatterns: [],
          healthAssessment: '',
        },
        issuesWouldCreate: [],
        issuesWouldSkip: [],
        llmDetails: {
          modelId: '',
          promptLength: 0,
          responseLength: 0,
          estimatedCost: '$0.0000',
        },
        error: errorMessage,
      };
    }
  }

  /**
   * Run triage for a specific config (multi-config support)
   *
   * This method is used by the SQS worker to process individual config jobs.
   * It uses the IssueTrackerService abstraction to support both GitHub and Jira.
   *
   * @param slackBotToken - Slack bot token for fetching alerts
   * @param issueTracker - Issue tracker service (GitHub or Jira)
   * @param config - LiveOps triage configuration document
   * @param options - Optional parameters
   * @returns Triage run result
   */
  async runTriageForConfig(
    slackBotToken: string,
    issueTracker: IssueTrackerService,
    config: ILiveopsTriageConfigDocument,
    options?: { lookbackHours?: number }
  ): Promise<TriageRunResult> {
    const effectiveLookbackHours = options?.lookbackHours ?? config.runIntervalHours;

    this.logger.info('[LIVEOPS-TRIAGE] Running triage for config', {
      configId: config.id,
      configName: config.name,
      issueTracker: issueTracker.type,
      lookbackHours: effectiveLookbackHours,
    });

    // Initialize Slack client
    await this.initSlackClient(slackBotToken);

    try {
      // Fetch alerts using config's Slack channel
      const alerts = await this.fetchSlackAlerts(config.slackChannelId, effectiveLookbackHours);

      if (alerts.length === 0) {
        this.logger.info('[LIVEOPS-TRIAGE] No alerts found in the lookback period', {
          configName: config.name,
          lookbackHours: effectiveLookbackHours,
        });

        // Post "all clear" message if enabled
        if (config.postWhenNoErrors) {
          const nextRun = getNextScheduledRun(config.runIntervalHours ?? 12);
          const outputChannelId = config.slackOutputChannelId || config.slackChannelId;
          await this.postNoErrorsMessage(outputChannelId, effectiveLookbackHours, nextRun);
        }

        return {
          status: 'success',
          errorsProcessed: 0,
          issuesCreated: [],
          issuesDeduplicated: 0,
          p0Issues: [],
          p1Issues: [],
        };
      }

      // Limit alerts to process
      const alertsToProcess = alerts.slice(0, config.maxErrorsPerRun);

      // Fetch existing issues using the issue tracker abstraction
      const trackerOpenIssues = await issueTracker.searchExistingIssues();
      const trackerClosedIssues = await issueTracker.fetchRecentlyClosedIssues(
        config.regressionLookbackDays ?? LIVEOPS_TRIAGE_VALIDATION_LIMITS.regressionLookbackDays.default
      );

      // Map tracker issues to service format
      const existingIssues: ExistingIssue[] = trackerOpenIssues.map(mapTrackerIssueToServiceIssue);
      const recentlyClosedIssues: ExistingIssue[] = trackerClosedIssues.map(mapTrackerIssueToServiceIssue);

      // === STEP 1: Generate fingerprints and pre-group alerts ===
      const alertsWithFingerprints = alertsToProcess.map(alert => ({
        alert,
        fingerprint: generateFingerprint(alert),
      }));

      // Group alerts by fingerprint for intra-batch deduplication
      const alertsByFingerprint = new Map<string, Array<{ alert: SlackAlert; fingerprint: string | null }>>();
      const alertsWithoutFingerprint: Array<{ alert: SlackAlert; fingerprint: string | null }> = [];

      for (const alertWithFp of alertsWithFingerprints) {
        if (alertWithFp.fingerprint) {
          const group = alertsByFingerprint.get(alertWithFp.fingerprint) || [];
          group.push(alertWithFp);
          alertsByFingerprint.set(alertWithFp.fingerprint, group);
        } else {
          alertsWithoutFingerprint.push(alertWithFp);
        }
      }

      // Log fingerprint statistics
      this.logger.info('[LIVEOPS-METRICS] Fingerprint statistics', {
        configName: config.name,
        totalAlerts: alertsToProcess.length,
        uniqueFingerprints: alertsByFingerprint.size,
        alertsWithoutFingerprint: alertsWithoutFingerprint.length,
        collisionRate:
          alertsByFingerprint.size > 0
            ? (
                ((alertsToProcess.length - alertsWithoutFingerprint.length - alertsByFingerprint.size) /
                  (alertsToProcess.length - alertsWithoutFingerprint.length)) *
                100
              ).toFixed(1) + '%'
            : 'N/A',
      });

      // === STEP 2: Build fingerprint index of existing issues ===
      const {
        openIssuesByFingerprint,
        closedIssuesByFingerprint,
        openIssuesBySemanticFingerprint,
        closedIssuesBySemanticFingerprint,
      } = this.buildFingerprintIndexes(existingIssues, recentlyClosedIssues);

      this.logger.info('[LIVEOPS-TRIAGE] Fingerprint index built', {
        configName: config.name,
        openIssuesWithFingerprint: openIssuesByFingerprint.size,
        closedIssuesWithFingerprint: closedIssuesByFingerprint.size,
        openIssuesWithSemanticFingerprint: openIssuesBySemanticFingerprint.size,
        closedIssuesWithSemanticFingerprint: closedIssuesBySemanticFingerprint.size,
      });

      // === STEP 3: Pre-match alerts against existing issues by fingerprint ===
      const { preMatchedResults, alertsNeedingLLM, fingerprintToAlerts } = this.preMatchAlertsByFingerprint(
        alertsByFingerprint as Map<string, Array<{ alert: SlackAlert; fingerprint: string }>>,
        alertsWithoutFingerprint,
        openIssuesByFingerprint,
        closedIssuesByFingerprint,
        openIssuesBySemanticFingerprint,
        closedIssuesBySemanticFingerprint,
        { enableAuditLogs: true }
      );

      this.logger.info('[LIVEOPS-TRIAGE] Pre-matching complete', {
        configName: config.name,
        preMatchedByFingerprint: preMatchedResults.length,
        alertsNeedingLLM: alertsNeedingLLM.length,
      });

      // === STEP 4: Triage remaining alerts with LLM ===
      // Build config object for LLM triage (uses config's settings)
      const llmConfig: LiveopsTriageConfig = {
        enabled: config.enabled,
        slackWorkspaceId: config.slackWorkspaceId?.toString(),
        slackChannelId: config.slackChannelId,
        slackOutputChannelId: config.slackOutputChannelId,
        githubOwner: config.githubOwner || '',
        githubRepo: config.githubRepo || '',
        modelId: config.modelId,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
        maxErrorsPerRun: config.maxErrorsPerRun,
        regressionLookbackDays: config.regressionLookbackDays,
        regressionGracePeriodHours: config.regressionGracePeriodHours ?? DEFAULT_REGRESSION_GRACE_PERIOD_HOURS,
        autoCreateIssues: config.autoCreateIssues,
        runIntervalHours: config.runIntervalHours,
        postWhenNoErrors: config.postWhenNoErrors,
        promptTemplate: config.promptTemplate,
      };

      let triageResponse: LLMTriageResponse;
      if (alertsNeedingLLM.length > 0) {
        triageResponse = await this.triageAlertsWithLLM(
          alertsNeedingLLM,
          existingIssues,
          recentlyClosedIssues,
          llmConfig
        );

        // Build alert ID -> fingerprint map for O(1) lookup
        const alertIdToFingerprint = new Map<
          string,
          { fingerprint: string; semanticFingerprint: string | null; alertCount: number }
        >();
        for (const [fp, fpAlerts] of fingerprintToAlerts.entries()) {
          for (const alert of fpAlerts) {
            const semanticFp = generateSemanticFingerprint(alert);
            alertIdToFingerprint.set(alert.ts, {
              fingerprint: fp,
              semanticFingerprint: semanticFp,
              alertCount: fpAlerts.length,
            });
          }
        }

        // Attach fingerprints to LLM results
        for (const result of triageResponse.triageResults) {
          const fpData = alertIdToFingerprint.get(result.alertId);
          if (fpData) {
            result.fingerprint = fpData.fingerprint;
            result.semanticFingerprint = fpData.semanticFingerprint;
            if (fpData.alertCount > 1) {
              result.occurrenceCount = fpData.alertCount;
              result.isRecurring = true;
            }
          }

          // Check if this alert matches a closed issue for regression (via fingerprint)
          if (result.fingerprint) {
            const matchedClosedIssue = closedIssuesByFingerprint.get(result.fingerprint);
            if (matchedClosedIssue && matchedClosedIssue.closedAt) {
              const closedAt = new Date(matchedClosedIssue.closedAt).getTime();
              if (
                Date.now() - closedAt >
                (config.regressionGracePeriodHours ?? DEFAULT_REGRESSION_GRACE_PERIOD_HOURS) * 60 * 60 * 1000
              ) {
                result.isRegression = true;
                result.matchedClosedIssue = {
                  issueNumber: matchedClosedIssue.number,
                  title: matchedClosedIssue.title,
                  closedAt: matchedClosedIssue.closedAt,
                };
              }
            }
          }

          // Also check if LLM matched against a closed issue (even without fingerprint match)
          checkLLMMatchedClosedIssueRegression(
            result,
            recentlyClosedIssues,
            config.regressionGracePeriodHours ?? DEFAULT_REGRESSION_GRACE_PERIOD_HOURS
          );
        }

        // === STEP 4.5: Post-LLM title matching (catches duplicates that fingerprint + LLM missed) ===
        const allIssuesForTitleMatchMulti = [...existingIssues, ...recentlyClosedIssues];
        this.postMatchByTitle(triageResponse.triageResults, allIssuesForTitleMatchMulti, {
          enableAuditLogs: true,
          similarityThreshold: 0.9,
          minTitleLength: 40,
          regressionGracePeriodHours: config.regressionGracePeriodHours ?? DEFAULT_REGRESSION_GRACE_PERIOD_HOURS,
        });

        this.logger.info('[LIVEOPS-TRIAGE] Post-LLM title matching complete', {
          configName: config.name,
          titleMatchedCount: triageResponse.triageResults.filter(r => r.matchesExisting && !r.fingerprint).length,
        });

        // === STEP 5: Post-LLM validation - merge duplicates with same fingerprint ===
        const fingerprintToResult = new Map<string, TriageResult>();
        const duplicatesToRemove: number[] = [];

        for (let i = 0; i < triageResponse.triageResults.length; i++) {
          const result = triageResponse.triageResults[i];
          const fp = result.fingerprint;

          if (fp && fingerprintToResult.has(fp) && !result.matchesExisting) {
            const existing = fingerprintToResult.get(fp)!;
            existing.occurrenceCount += result.occurrenceCount;
            duplicatesToRemove.push(i);

            this.logger.info('[LIVEOPS-TRIAGE] Post-validation merged duplicate', {
              configName: config.name,
              fingerprint: fp.slice(0, 8),
              mergedInto: existing.title,
              removedTitle: result.title,
            });
          } else if (fp) {
            fingerprintToResult.set(fp, result);
          }
        }

        // Remove duplicates from results
        for (const idx of duplicatesToRemove.reverse()) {
          triageResponse.triageResults.splice(idx, 1);
        }

        // Merge pre-matched results into the response
        triageResponse.triageResults.push(...preMatchedResults);
        triageResponse.summary.duplicates += preMatchedResults.length;
      } else {
        // All alerts were pre-matched by fingerprint
        triageResponse = {
          triageResults: preMatchedResults,
          summary: {
            totalAlerts: alertsToProcess.length,
            newIssues: 0,
            duplicates: preMatchedResults.length,
            regressions: 0,
            p0Count: 0,
            p1Count: 0,
            p2Count: 0,
            p3Count: 0,
            recurringPatterns: [],
            healthAssessment: 'All alerts matched existing issues by fingerprint.',
          },
        };
      }

      // Create issues using the issue tracker abstraction
      const createdIssues: Array<{
        number: number;
        title: string;
        priority: string;
        url: string;
        isRegression?: boolean;
        matchedClosedIssue?: { issueNumber: number; title: string; closedAt?: string | null } | null;
      }> = [];
      const matchedExistingIssues: Array<{
        issueNumber: number;
        title: string;
        priority: string;
        repoFullName: string;
      }> = [];
      const p0Issues: number[] = [];
      const p1Issues: number[] = [];

      // Build tracker identifier for logging
      const trackerIdentifier =
        issueTracker.type === 'github'
          ? `${config.githubOwner}/${config.githubRepo}`
          : config.jiraProjectKey || 'unknown';

      for (const result of triageResponse.triageResults) {
        // Track matched existing issues for Slack summary
        if (result.matchesExisting) {
          matchedExistingIssues.push({
            issueNumber: result.matchesExisting.issueNumber,
            title: result.matchesExisting.title,
            priority: result.priority,
            repoFullName: trackerIdentifier,
          });

          this.logger.info('[LIVEOPS-TRIAGE-AUDIT] Issue deduplicated', {
            action: 'issue_deduplicated',
            configName: config.name,
            tracker: trackerIdentifier,
            matchedIssue: result.matchesExisting,
            priority: result.priority,
            category: result.category,
            title: result.title,
            timestamp: new Date().toISOString(),
          });
          continue;
        }

        // Only create issues if auto-create is enabled
        if (config.autoCreateIssues) {
          // The tracker's createIssue appends the fingerprint, so don't duplicate it here
          const createParams: CreateIssueParams = {
            title: result.title,
            body: result.body,
            priority: result.priority,
            labels: result.labels,
            fingerprint: result.fingerprint || '',
            isRegression: result.isRegression,
          };

          const createdIssue = await issueTracker.createIssue(createParams);

          if (createdIssue) {
            // Extract issue number from key for internal tracking
            let issueNumber = -1;
            const githubMatch = createdIssue.key.match(/#(\d+)$/);
            if (githubMatch) {
              issueNumber = parseInt(githubMatch[1], 10);
            } else {
              const jiraMatch = createdIssue.key.match(/-(\d+)$/);
              if (jiraMatch) {
                issueNumber = parseInt(jiraMatch[1], 10);
              }
            }

            createdIssues.push({
              number: issueNumber,
              title: result.title,
              priority: result.priority,
              url: createdIssue.url,
              isRegression: result.isRegression,
              matchedClosedIssue: result.matchedClosedIssue,
            });

            if (result.priority === 'P0') {
              p0Issues.push(issueNumber);
            } else if (result.priority === 'P1') {
              p1Issues.push(issueNumber);
            }

            this.logger.info('[LIVEOPS-TRIAGE-AUDIT] Issue created', {
              action: 'issue_created',
              configName: config.name,
              tracker: issueTracker.type,
              issueKey: createdIssue.key,
              issueUrl: createdIssue.url,
              priority: result.priority,
              isRegression: result.isRegression,
            });
          } else {
            this.logger.warn('[LIVEOPS-TRIAGE] Issue creation failed', {
              configName: config.name,
              title: result.title,
              priority: result.priority,
              tracker: issueTracker.type,
            });
          }
        }
      }

      // Post summary to Slack
      const outputChannelId = config.slackOutputChannelId || config.slackChannelId;
      const nextScheduledRun = getNextScheduledRun(config.runIntervalHours ?? 12);
      await this.postTriageSummary(
        outputChannelId,
        triageResponse.summary,
        createdIssues,
        matchedExistingIssues,
        effectiveLookbackHours,
        nextScheduledRun
      );

      this.logger.info('[LIVEOPS-TRIAGE] Triage completed successfully', {
        configId: config.id,
        configName: config.name,
        errorsProcessed: alertsToProcess.length,
        issuesCreated: createdIssues.length,
        issuesDeduplicated: triageResponse.summary.duplicates,
      });

      return {
        status: 'success',
        errorsProcessed: alertsToProcess.length,
        issuesCreated: createdIssues.map(i => i.number),
        issuesDeduplicated: triageResponse.summary.duplicates,
        p0Issues,
        p1Issues,
        summary: triageResponse.summary,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error('[LIVEOPS-TRIAGE] Triage run failed', {
        configId: config.id,
        configName: config.name,
        error: errorMessage,
      });

      return {
        status: 'failed',
        errorsProcessed: 0,
        issuesCreated: [],
        issuesDeduplicated: 0,
        p0Issues: [],
        p1Issues: [],
        error: errorMessage,
      };
    }
  }

  /**
   * Run dry run for a specific config (multi-config support)
   *
   * This method is used by the SQS worker to perform dry runs for individual configs.
   * It processes alerts and runs LLM triage but does not create issues.
   *
   * @param slackBotToken - Slack bot token for fetching alerts
   * @param issueTracker - Issue tracker service (GitHub or Jira)
   * @param config - LiveOps triage configuration document
   * @param options - Optional parameters
   * @returns Dry run result
   */
  async runDryRunForConfig(
    slackBotToken: string,
    issueTracker: IssueTrackerService,
    config: ILiveopsTriageConfigDocument,
    options?: { lookbackHours?: number }
  ): Promise<DryRunResult> {
    const effectiveLookbackHours = options?.lookbackHours ?? config.runIntervalHours;

    const dryRunResolvedModelId = resolveDeprecatedModelId(config.modelId, 'liveopsTriageDryRunForConfig');

    this.logger.info('[LIVEOPS-TRIAGE] Running dry run for config', {
      configId: config.id,
      configName: config.name,
      issueTracker: issueTracker.type,
      lookbackHours: effectiveLookbackHours,
    });

    // Initialize Slack client
    await this.initSlackClient(slackBotToken);

    try {
      // Fetch alerts using config's Slack channel
      const alerts = await this.fetchSlackAlerts(config.slackChannelId, effectiveLookbackHours);

      if (alerts.length === 0) {
        return {
          status: 'success',
          dryRun: true,
          lookbackHours: effectiveLookbackHours,
          alertsFetched: 0,
          alertsToProcess: 0,
          existingIssuesFound: 0,
          triageResults: [],
          summary: {
            totalAlerts: 0,
            newIssues: 0,
            duplicates: 0,
            regressions: 0,
            p0Count: 0,
            p1Count: 0,
            p2Count: 0,
            p3Count: 0,
            recurringPatterns: [],
            healthAssessment: 'No alerts found in the lookback period.',
          },
          issuesWouldCreate: [],
          issuesWouldSkip: [],
          llmDetails: {
            modelId: config.modelId,
            promptLength: 0,
            responseLength: 0,
            estimatedCost: '$0.0000',
          },
        };
      }

      // Limit alerts to process
      const alertsToProcess = alerts.slice(0, config.maxErrorsPerRun);

      // Fetch existing issues using the issue tracker abstraction
      const trackerOpenIssues = await issueTracker.searchExistingIssues();
      const trackerClosedIssues = await issueTracker.fetchRecentlyClosedIssues(
        config.regressionLookbackDays ?? LIVEOPS_TRIAGE_VALIDATION_LIMITS.regressionLookbackDays.default
      );

      // Map tracker issues to service format
      const existingIssues: ExistingIssue[] = trackerOpenIssues.map(mapTrackerIssueToServiceIssue);
      const recentlyClosedIssues: ExistingIssue[] = trackerClosedIssues.map(mapTrackerIssueToServiceIssue);

      // Generate fingerprints and pre-group alerts
      const alertsWithFingerprints = alertsToProcess.map(alert => ({
        alert,
        fingerprint: generateFingerprint(alert),
      }));

      // Group alerts by fingerprint
      const alertsByFingerprint = new Map<string, Array<{ alert: SlackAlert; fingerprint: string | null }>>();
      const alertsWithoutFingerprint: Array<{ alert: SlackAlert; fingerprint: string | null }> = [];

      for (const alertWithFp of alertsWithFingerprints) {
        if (alertWithFp.fingerprint) {
          const group = alertsByFingerprint.get(alertWithFp.fingerprint) || [];
          group.push(alertWithFp);
          alertsByFingerprint.set(alertWithFp.fingerprint, group);
        } else {
          alertsWithoutFingerprint.push(alertWithFp);
        }
      }

      // Build fingerprint indexes
      const {
        openIssuesByFingerprint,
        closedIssuesByFingerprint,
        openIssuesBySemanticFingerprint,
        closedIssuesBySemanticFingerprint,
      } = this.buildFingerprintIndexes(existingIssues, recentlyClosedIssues);

      // Pre-match alerts
      const { preMatchedResults, alertsNeedingLLM, fingerprintToAlerts } = this.preMatchAlertsByFingerprint(
        alertsByFingerprint as Map<string, Array<{ alert: SlackAlert; fingerprint: string }>>,
        alertsWithoutFingerprint,
        openIssuesByFingerprint,
        closedIssuesByFingerprint,
        openIssuesBySemanticFingerprint,
        closedIssuesBySemanticFingerprint,
        { enableAuditLogs: false }
      );

      // Build config object for LLM triage
      const llmConfig: LiveopsTriageConfig = {
        enabled: config.enabled,
        slackWorkspaceId: config.slackWorkspaceId?.toString(),
        slackChannelId: config.slackChannelId,
        slackOutputChannelId: config.slackOutputChannelId,
        githubOwner: config.githubOwner || '',
        githubRepo: config.githubRepo || '',
        modelId: config.modelId,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
        maxErrorsPerRun: config.maxErrorsPerRun,
        regressionLookbackDays: config.regressionLookbackDays,
        regressionGracePeriodHours: config.regressionGracePeriodHours ?? DEFAULT_REGRESSION_GRACE_PERIOD_HOURS,
        autoCreateIssues: config.autoCreateIssues,
        runIntervalHours: config.runIntervalHours,
        postWhenNoErrors: config.postWhenNoErrors,
        promptTemplate: config.promptTemplate,
      };

      let triageResponse: LLMTriageResponse;
      let promptLength = 0;
      let responseLength = 0;

      // Build prompt for dry run details
      const template = llmConfig.promptTemplate || getDefaultTemplateString();
      const alertsJson = JSON.stringify(
        alertsNeedingLLM.map(a => ({
          id: a.ts,
          text: a.text,
          timestamp: a.timestamp.toISOString(),
        })),
        null,
        2
      );
      const existingIssuesText =
        existingIssues.length > 0
          ? existingIssues.map(formatIssueForPrompt).join('\n')
          : 'No existing liveops issues found.';
      const recentlyClosedIssuesText =
        recentlyClosedIssues.length > 0
          ? recentlyClosedIssues.map(formatIssueForPrompt).join('\n')
          : 'No recently closed liveops issues found.';
      const trackerIdentifier =
        issueTracker.type === 'github'
          ? `${config.githubOwner}/${config.githubRepo}`
          : config.jiraProjectKey || 'unknown';
      const prompt = interpolateTemplate(template, {
        alerts: alertsJson,
        existingIssues: existingIssuesText,
        recentlyClosedIssues: recentlyClosedIssuesText,
        priorityGuidelines: PRIORITY_GUIDELINES,
        repoName: trackerIdentifier,
      });

      if (alertsNeedingLLM.length > 0) {
        triageResponse = await this.triageAlertsWithLLM(
          alertsNeedingLLM,
          existingIssues,
          recentlyClosedIssues,
          llmConfig
        );

        // Capture lengths for cost calculation
        promptLength = prompt.length;
        responseLength = JSON.stringify(triageResponse).length;

        // Attach fingerprints to LLM results
        const alertIdToFingerprint = new Map<
          string,
          { fingerprint: string; semanticFingerprint: string | null; alertCount: number }
        >();
        for (const [fp, fpAlerts] of fingerprintToAlerts.entries()) {
          for (const alert of fpAlerts) {
            const semanticFp = generateSemanticFingerprint(alert);
            alertIdToFingerprint.set(alert.ts, {
              fingerprint: fp,
              semanticFingerprint: semanticFp,
              alertCount: fpAlerts.length,
            });
          }
        }

        for (const result of triageResponse.triageResults) {
          const fpData = alertIdToFingerprint.get(result.alertId);
          if (fpData) {
            result.fingerprint = fpData.fingerprint;
            result.semanticFingerprint = fpData.semanticFingerprint;
            if (fpData.alertCount > 1) {
              result.occurrenceCount = fpData.alertCount;
              result.isRecurring = true;
            }
          }

          // Check for regression (via fingerprint)
          if (result.fingerprint) {
            const matchedClosedIssue = closedIssuesByFingerprint.get(result.fingerprint);
            if (matchedClosedIssue && matchedClosedIssue.closedAt) {
              const closedAt = new Date(matchedClosedIssue.closedAt).getTime();
              if (
                Date.now() - closedAt >
                (config.regressionGracePeriodHours ?? DEFAULT_REGRESSION_GRACE_PERIOD_HOURS) * 60 * 60 * 1000
              ) {
                result.isRegression = true;
                result.matchedClosedIssue = {
                  issueNumber: matchedClosedIssue.number,
                  title: matchedClosedIssue.title,
                  closedAt: matchedClosedIssue.closedAt,
                };
              }
            }
          }

          // Also check if LLM matched against a closed issue (even without fingerprint match)
          checkLLMMatchedClosedIssueRegression(
            result,
            recentlyClosedIssues,
            config.regressionGracePeriodHours ?? DEFAULT_REGRESSION_GRACE_PERIOD_HOURS
          );
        }

        // Post-LLM title matching (catches duplicates that fingerprint + LLM missed)
        const allIssuesForTitleMatchConfig = [...existingIssues, ...recentlyClosedIssues];
        this.postMatchByTitle(triageResponse.triageResults, allIssuesForTitleMatchConfig, {
          enableAuditLogs: false, // Less verbose for dry run
          similarityThreshold: 0.9,
          minTitleLength: 40,
          regressionGracePeriodHours: config.regressionGracePeriodHours ?? DEFAULT_REGRESSION_GRACE_PERIOD_HOURS,
        });

        // Merge pre-matched results
        triageResponse.triageResults.push(...preMatchedResults);
        triageResponse.summary.duplicates += preMatchedResults.length;
      } else {
        triageResponse = {
          triageResults: preMatchedResults,
          summary: {
            totalAlerts: alertsToProcess.length,
            newIssues: 0,
            duplicates: preMatchedResults.length,
            regressions: 0,
            p0Count: 0,
            p1Count: 0,
            p2Count: 0,
            p3Count: 0,
            recurringPatterns: [],
            healthAssessment: 'All alerts matched existing issues by fingerprint.',
          },
        };
      }

      // Build dry run results
      const issuesWouldCreate: DryRunResult['issuesWouldCreate'] = [];
      const issuesWouldSkip: DryRunResult['issuesWouldSkip'] = [];

      for (const result of triageResponse.triageResults) {
        if (result.matchesExisting) {
          issuesWouldSkip.push({
            title: result.title,
            priority: result.priority,
            matchesExisting: result.matchesExisting,
          });
        } else {
          issuesWouldCreate.push({
            title: `[LiveOps] ${result.title}`,
            priority: result.priority,
            category: result.category,
            body: this.formatIssueBody(result),
            labels: result.isRegression
              ? ['bug', 'liveops', result.priority, 'regression']
              : ['bug', 'liveops', result.priority],
            isRecurring: result.isRecurring,
            occurrenceCount: result.occurrenceCount,
            isRegression: result.isRegression,
          });
        }
      }

      // Estimate cost
      const inputTokens = Math.ceil(promptLength / CHARS_PER_TOKEN);
      const outputTokens = Math.ceil(responseLength / CHARS_PER_TOKEN);
      const estimatedCost = calculateLLMCost(dryRunResolvedModelId, inputTokens, outputTokens);

      this.logger.info('[LIVEOPS-TRIAGE] Dry run completed', {
        configId: config.id,
        configName: config.name,
        alertsToProcess: alertsToProcess.length,
        issuesWouldCreate: issuesWouldCreate.length,
        issuesWouldSkip: issuesWouldSkip.length,
      });

      return {
        status: 'success',
        dryRun: true,
        lookbackHours: effectiveLookbackHours,
        alertsFetched: alerts.length,
        alertsToProcess: alertsToProcess.length,
        existingIssuesFound: existingIssues.length,
        triageResults: triageResponse.triageResults,
        summary: triageResponse.summary,
        issuesWouldCreate,
        issuesWouldSkip,
        llmDetails: {
          modelId: config.modelId,
          promptLength,
          responseLength,
          estimatedCost: `$${estimatedCost.toFixed(4)}`,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error('[LIVEOPS-TRIAGE] Dry run failed', {
        configId: config.id,
        configName: config.name,
        error: errorMessage,
      });

      return {
        status: 'failed',
        dryRun: true,
        lookbackHours: effectiveLookbackHours,
        alertsFetched: 0,
        alertsToProcess: 0,
        existingIssuesFound: 0,
        triageResults: [],
        summary: {
          totalAlerts: 0,
          newIssues: 0,
          duplicates: 0,
          regressions: 0,
          p0Count: 0,
          p1Count: 0,
          p2Count: 0,
          p3Count: 0,
          recurringPatterns: [],
          healthAssessment: `Error: ${errorMessage}`,
        },
        issuesWouldCreate: [],
        issuesWouldSkip: [],
        llmDetails: {
          modelId: config.modelId,
          promptLength: 0,
          responseLength: 0,
          estimatedCost: '$0.0000',
        },
        error: errorMessage,
      };
    }
  }
}

/**
 * Factory function to create a service instance
 */
export function createLiveopsTriageService(logger?: Logger): LiveopsTriageService {
  return new LiveopsTriageService(logger || new Logger({ metadata: { service: 'LiveopsTriageService' } }));
}
