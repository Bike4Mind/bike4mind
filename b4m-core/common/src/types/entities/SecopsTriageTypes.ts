import { z } from 'zod';

/** An `owner/name` GitHub repository; also used by the worker's repository check. */
export const SECOPS_TRIAGE_REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const MAX_ISSUES_MESSAGE = 'Max issues per scan must be between 1 and 100';

/**
 * The fields of the SecOps Triage config without the cross-field rules. Parses a saved value that
 * breaks one of those rules, so a form can still show it for correction.
 */
export const SecopsTriageConfigFieldsSchema = z.object({
  /** Master kill switch */
  enabled: z.boolean().default(false),

  /** GitHub repository to create issues in (e.g. 'owner/repo') */
  githubRepo: z.string().default(''),

  /** Minimum ZAP severity level that triggers issue creation */
  severityThreshold: z.enum(['critical', 'high']).default('high'),

  /** Map ZAP severity levels to GitHub issue priority labels */
  severityToPriority: z
    .object({
      critical: z.enum(['P0', 'P1']).default('P0'),
      high: z.enum(['P0', 'P1']).default('P1'),
    })
    .default({ critical: 'P0', high: 'P1' }),

  /** Maximum number of issues to create per scan (sorted by severity, highest first) */
  maxIssuesPerScan: z
    .number({ error: MAX_ISSUES_MESSAGE })
    .min(1, MAX_ISSUES_MESSAGE)
    .max(100, MAX_ISSUES_MESSAGE)
    .default(20),

  /** Slack workspace ID to use for posting (must match an active workspace in Admin -> Slack Workspaces). Falls back to first active workspace if not set. */
  slackWorkspaceId: z.string().optional(),

  /** Slack channel ID to post triage summary to (optional) */
  slackChannelId: z.string().optional(),

  /** Enable LLM enrichment: per-finding remediation guidance + overall health assessment */
  llmEnrichment: z.boolean().default(false),

  /** LLM model ID to use for enrichment (e.g. 'claude-3-5-haiku-20241022') */
  modelId: z.string().optional(),

  /** Log actions without creating real GitHub issues or posting to Slack */
  dryRun: z.boolean().default(false),
});

/**
 * Configuration schema for the SecOps Triage feature.
 *
 * Controls automatic GitHub issue creation for critical/high ZAP scan findings.
 * Triggered via SQS fan-out from the web-owasp-ingest endpoint after each scan.
 *
 * Setting name: 'secopsTriageConfig'
 */
export const SecopsTriageConfigSchema = SecopsTriageConfigFieldsSchema.refine(
  data => !data.llmEnrichment || !!data.modelId,
  {
    message: 'A model must be selected when LLM enrichment is enabled',
    path: ['modelId'],
  }
).refine(data => !data.enabled || SECOPS_TRIAGE_REPO_PATTERN.test(data.githubRepo), {
  message: 'A repository in owner/name form is required when SecOps triage is enabled',
  path: ['githubRepo'],
});

export type SecopsTriageConfig = z.infer<typeof SecopsTriageConfigSchema>;

export const SECOPS_TRIAGE_SCAN_SOURCES = [
  'web-owasp',
  'secrets',
  'packages',
  'code-semgrep',
  'cloud',
  'active-defense',
] as const;
export type SecopsTriageScanSource = (typeof SECOPS_TRIAGE_SCAN_SOURCES)[number];
