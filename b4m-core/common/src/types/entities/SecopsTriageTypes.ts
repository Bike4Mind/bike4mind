import { z } from 'zod';

/**
 * Configuration schema for the SecOps Triage feature.
 *
 * Controls automatic GitHub issue creation for critical/high ZAP scan findings.
 * Triggered via SQS fan-out from the web-owasp-ingest endpoint after each scan.
 *
 * Setting name: 'secopsTriageConfig'
 */
export const SecopsTriageConfigSchema = z
  .object({
    /** Master kill switch */
    enabled: z.boolean().default(false),

    /** GitHub repository to create issues in (e.g. 'MillionOnMars/lumina5') */
    githubRepo: z.string().default('MillionOnMars/lumina5'),

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
    maxIssuesPerScan: z.number().min(1).max(100).default(20),

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
  })
  .refine(data => !data.llmEnrichment || !!data.modelId, {
    message: 'modelId is required when llmEnrichment is enabled',
    path: ['modelId'],
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
