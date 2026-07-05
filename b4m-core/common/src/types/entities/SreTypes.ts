/**
 * SRE Agent Trio - Shared Types
 *
 * Types for the autonomous SRE pipeline:
 *   Sentinel (error intake) -> Diagnostician (LLM analysis) -> Surgeon (automated fix)
 */

import { z } from 'zod';

// ============================================
// Enums
// ============================================

export enum SreClassification {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
  SKIP = 'SKIP',
}

export enum SreSourceType {
  CLOUDWATCH = 'CLOUDWATCH',
  GITHUB_ISSUE = 'GITHUB_ISSUE',
}

export enum SreTrackingStatus {
  DETECTED = 'detected',
  ANALYZING = 'analyzing',
  AWAITING_APPROVAL = 'awaiting_approval',
  FIXING = 'fixing',
  FIXED = 'fixed',
  ALREADY_FIXED = 'already_fixed',
  FAILED = 'failed',
  WONT_FIX = 'wont_fix',
  DISPATCH_FAILED = 'dispatch_failed',
  DRY_RUN = 'dry_run',
  SCOPE_BLOCKED = 'scope_blocked',
  APPROVAL_EXPIRED = 'approval_expired',
  REVISION_REQUESTED = 'revision_requested',
  RECURRENCE_DETECTED = 'recurrence_detected',
  LOW_CONFIDENCE = 'low_confidence',
  RATE_LIMITED = 'rate_limited',
  DISMISSED = 'dismissed',
}

/** Default maximum number of revision attempts before escalating to human */
export const MAX_SRE_REVISIONS_DEFAULT = 2;

/**
 * Test-file glob patterns. Tests are NOT in the global block list - the initial
 * diagnosis may update a test assertion when paired with a real source change
 * (Rule 1: "tests follow code, never lead"). These globs are injected into
 * blockedFilePatterns ONLY for CI self-heal revisions (Rule 2: never edit a test
 * while iterating on a red CI run - fix the source or escalate to a human).
 * Keep in sync with the isTestFile() matcher in scripts/apply-sre-fix.cjs.
 */
export const SRE_TEST_FILE_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'] as const;

/**
 * Whether a file path is a test file. Used by the Diagnostician to enforce the
 * tests-follow-code guardrail. Mirror of isTestFile() in apply-sre-fix.cjs.
 */
export function isSreTestFile(filePath: string): boolean {
  // Normalize separators so __tests__ detection is platform-independent (Windows-style \ paths).
  const p = filePath.replace(/\\/g, '/');
  return /(^|\/)__tests__\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

// ============================================
// Event Payload (normalized from either source)
// ============================================

export interface SreEventPayload {
  /** Source of the error */
  source: SreSourceType;
  /** Normalized error fingerprint (source-agnostic) */
  fingerprint: string;
  /** Repository slug (owner/repo) - identifies which repo this error belongs to */
  repoSlug?: string;
  /** Classification from heuristics (Sentinel) */
  classification: SreClassification;
  /** Error message / description */
  errorMessage: string;
  /** Stack trace (CloudWatch) or issue body (GitHub) */
  stackTrace?: string;
  /** Lambda function name (CloudWatch) */
  functionName?: string;
  /** CloudWatch log group (CloudWatch) */
  logGroup?: string;
  /** GitHub issue number (GitHub) */
  issueNumber?: number;
  /** GitHub issue URL (GitHub) */
  issueUrl?: string;
  /** GitHub issue labels (GitHub) */
  labels?: string[];
  /** Affected user IDs (CloudWatch - extracted from structured log metadata) */
  affectedUserIds?: string[];
  /** Whether this event was queued in dry-run mode */
  dryRun?: boolean;
  /**
   * GitHub webhook action that triggered this dispatch - used downstream to
   * disambiguate fix-loop alerts. `'reopened'` signals that the
   * original reporter actively reopened the issue after an SRE-merged fix,
   * which is a stronger "fix didn't work" signal than a natural recurrence of
   * the same fingerprint. Only set for GitHub-sourced flows; CloudWatch
   * sources leave this undefined.
   */
  triggerAction?: 'opened' | 'labeled' | 'reopened';
}

// ============================================
// Diagnosis Result
// ============================================

export interface SreDiagnosis {
  /** Root cause analysis */
  rootCause: string;
  /** Proposed fix description */
  proposedFix: string;
  /** Confidence score 0-100 */
  confidence: number;
  /** Risk assessment of the proposed fix */
  riskAssessment: string;
  /** Files involved in the fix */
  affectedFiles: Array<{
    filePath: string;
    before: string;
    after: string;
    /**
     * 'replace' (default): replace `before` with `after`.
     * 'insert': `before` is a unique anchor line that already exists in the file;
     * `after` must start with `before` verbatim, with the new code appended after the anchor.
     * 'create': the target file does not yet exist; `before` is ignored, `after` is the
     * full file contents to write. Used for adding regression tests, new utilities, etc.
     */
    kind?: 'insert' | 'replace' | 'create';
  }>;
  /** LLM tool-use transcript (for audit trail) */
  toolCalls?: Array<{
    tool: string;
    input: Record<string, unknown>;
    output: string;
  }>;
  /**
   * If true, the Diagnostician has identified this as a recurrence of a prior
   * ineffective workaround and is escalating to human review rather than
   * proposing another incremental fix. Handler routes to the escalation path
   * when set, regardless of whether the deterministic Layer 1 gate fired.
   */
  escalate?: boolean;
  /**
   * GitHub issue number tracking the real root-cause investigation (the
   * non-workaround fix). Populated by the LLM when escalating, or by an
   * operator via the pattern-library PATCH endpoint.
   */
  rootCauseTrackingIssue?: number;
}

// ============================================
// Fix Request (Diagnostician -> Surgeon)
// ============================================

export interface SreFixRequest {
  /** Error tracking document ID */
  trackingId: string;
  /** Error fingerprint */
  fingerprint: string;
  /** Repository slug (owner/repo) */
  repoSlug?: string;
  /** Diagnosis result with proposed changes */
  diagnosis: SreDiagnosis;
  /** Source event metadata */
  source: SreSourceType;
  /** GitHub issue number (if applicable) */
  issueNumber?: number;
  /** Whether this fix request is a dry run */
  dryRun?: boolean;
  /**
   * When true, the applier must reject ANY patch touching a test file (Rule 2).
   * Set for CI self-heal revisions (recoverable test/typecheck/apply-fix failure):
   * the bot is iterating on a red CI run and must never edit a test to make it pass.
   * Threaded into the workflow as test globs appended to meta.blockedFilePatterns.
   */
  blockTestEdits?: boolean;
  /** Present when this is a revision of an existing fix PR */
  revision?: {
    /** Existing branch name to push revised commits to */
    branchName: string;
    /** Existing PR number */
    prNumber: number;
    /** Which revision attempt this is (1-based) */
    revisionCount: number;
  };
}

// ============================================
// Revision Request (PullRequestReviewHandler -> sreJobQueue, jobType: 'revision')
// ============================================

export interface SreRevisionRequest {
  /** Error tracking document ID */
  trackingId: string;
  /** Error fingerprint */
  fingerprint: string;
  /** Repository slug (owner/repo) */
  repoSlug?: string;
  /** Existing sre-fix/* branch name */
  branchName: string;
  /**
   * Existing PR number, or 0 for CI-retry fresh-branch flows.
   * 0 signals the revision handler (sreRevision.ts) to create a new branch and PR
   * rather than push to an existing one (the original CI failure occurred before PR creation).
   */
  prNumber: number;
  /** Reviewer's feedback text (sanitized before LLM use) */
  reviewBody?: string;
  /** Original diagnosis to feed back to Diagnostician */
  originalDiagnosis: SreDiagnosis;
  /** Source event metadata */
  source: SreSourceType;
  /** GitHub issue number (if applicable) */
  issueNumber?: number;
  /** CI failure output to feed back as context data (typecheck/apply-fix failure) */
  ciFailureOutput?: string;
}

// ============================================
// AdminSettings Config - Zod Schema (repos-only)
// ============================================

/** Default repo slug used for backward compatibility with existing data */
export const SRE_DEFAULT_REPO_SLUG = 'MillionOnMars/lumina5';

/** Placeholder mask for encrypted secrets in the admin UI round-trip.
 *  Used by: settings/fetch.ts (server -> client), settings/update.ts (client -> server),
 *  SreAgentTab.tsx (UI display). Must be identical across all three. */
export const SRE_SECRET_PLACEHOLDER = '••••••••';

/** Base allowed patterns - always merged into resolved config.
 *  Keep in sync with scripts/apply-sre-fix.cjs ALLOWED_PATTERNS */
export const SRE_BASE_ALLOWED_PATTERNS = [
  'apps/client/**',
  'b4m-core/services/**',
  'b4m-core/common/src/**',
  'b4m-core/utils/src/llm/**',
  'packages/database/src/**',
] as const;

const SRE_BLOCKED_FILE_DEFAULTS = [
  'infra/**',
  '*.secret*',
  '*.env*',
  '*migration*',
  '.github/workflows/**',
  '**/package.json',
  'pnpm-lock.yaml',
] as const;

// --- Gate sub-schema ---

const SRE_GATE_DEFAULTS = {
  enabled: true,
  autoThreshold: 85,
  askThreshold: 60,
  approvalTimeoutHours: 12,
} as const;

const SreGateConfigSchema = z
  .object({
    enabled: z.boolean().default(SRE_GATE_DEFAULTS.enabled),
    autoThreshold: z.number().min(0).max(100).default(SRE_GATE_DEFAULTS.autoThreshold),
    askThreshold: z.number().min(0).max(100).default(SRE_GATE_DEFAULTS.askThreshold),
    approvalTimeoutHours: z.number().min(1).default(SRE_GATE_DEFAULTS.approvalTimeoutHours),
  })
  .refine(data => data.autoThreshold >= data.askThreshold, {
    message: 'autoThreshold must be >= askThreshold',
    path: ['autoThreshold'],
  });

// --- Repo config schema (each repo is fully self-contained) ---

/**
 * Each repo is a completely independent, self-contained configuration unit.
 * No defaults, no inheritance - every project is different.
 */
export const SreRepoConfigSchema = z.object({
  /** GitHub org/user that owns the target repo */
  owner: z.string().min(1),
  /** Repository name */
  repo: z.string().min(1),
  /** Whether this repo's SRE pipeline is active */
  enabled: z.boolean().default(false),
  /** LLM model ID for Diagnostician */
  modelId: z.string().default('claude-sonnet-4-6'),
  /** Max diff lines per fix */
  maxDiffLines: z.number().min(1).default(50),
  /** Max fixes dispatched per day for this repo */
  maxFixesPerDay: z.number().min(0).default(5),
  /** Max revision attempts before escalating to human */
  maxRevisions: z.number().int().min(0).max(10).default(MAX_SRE_REVISIONS_DEFAULT),
  /** Max CI retry attempts before permanently failing (typecheck/apply-fix/test failures) */
  maxCiRetries: z.number().int().min(0).max(3).default(2),
  /** Log actions without dispatching */
  dryRun: z.boolean().default(false),
  /** Comma-separated GitHub usernames to request as PR reviewers */
  reviewers: z.string().default(''),
  /** Default branch name (auto-detected via GitHub API if empty) */
  defaultBranch: z.string().default(''),
  /** Build command for the workflow */
  buildCommand: z.string().default(''),
  /**
   * Repository-specific instructions for the Diagnostician (max 2,000 chars).
   * For critical constraints that would cause broken fixes if unknown - e.g., "never modify X",
   * "all DB calls must go through Y wrapper". Not for general coding conventions (use CLAUDE.md).
   */
  sreInstructions: z.string().max(2000).default(''),
  /** Files the Surgeon can modify (glob patterns). Base patterns always merged in. */
  allowedFilePatterns: z.array(z.string()).default([]),
  /** Files never auto-fixed (glob patterns) */
  blockedFilePatterns: z.array(z.string()).default([...SRE_BLOCKED_FILE_DEFAULTS]),
  /** HMAC secret for webhook verification (encrypted at rest) */
  webhookSecret: z.string().default(''),
  /** Bearer token for workflow callback auth (encrypted at rest) */
  callbackToken: z.string().default(''),
  /** Human-in-the-loop approval gates */
  gates: z
    .object({
      sentinelToDiagnostician: SreGateConfigSchema.default({ ...SRE_GATE_DEFAULTS }),
      diagnosticianToSurgeon: SreGateConfigSchema.default({ ...SRE_GATE_DEFAULTS }),
    })
    .default({
      sentinelToDiagnostician: { ...SRE_GATE_DEFAULTS },
      diagnosticianToSurgeon: { ...SRE_GATE_DEFAULTS },
    }),
  /** Circuit breaker */
  circuitBreaker: z
    .object({
      failureThreshold: z.number().min(1).default(3),
      cooldownMinutes: z.number().min(1).default(30),
    })
    .default({ failureThreshold: 3, cooldownMinutes: 30 }),
  /** Token budget per analysis */
  tokenBudget: z
    .object({
      maxInputTokens: z.number().default(50000),
      maxOutputTokens: z.number().default(16000),
      maxGithubApiCalls: z.number().default(20),
    })
    .default({ maxInputTokens: 50000, maxOutputTokens: 16000, maxGithubApiCalls: 20 }),
  /** Error sources */
  sources: z
    .object({
      cloudwatch: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
      github: z
        .object({
          enabled: z.boolean().default(false),
          labelFilter: z
            .object({
              required: z.array(z.string()).default(['bug']),
              anyOf: z.array(z.string()).default([]),
            })
            .default({ required: ['bug'], anyOf: [] }),
        })
        .default({ enabled: false, labelFilter: { required: ['bug'], anyOf: [] } }),
    })
    .default({
      cloudwatch: { enabled: false },
      github: { enabled: false, labelFilter: { required: ['bug'], anyOf: [] } },
    }),
  /** Recurrence guard */
  recurrence: z
    .object({
      enabled: z.boolean().default(true),
      windowDays: z.number().int().min(1).max(30).default(14),
      threshold: z.number().int().min(1).max(10).default(1),
    })
    .default({ enabled: true, windowDays: 14, threshold: 1 }),
  /** Pattern library */
  patternLibrary: z
    .object({
      enabled: z.boolean().default(true),
      minConfidence: z.number().min(0).max(100).default(80),
    })
    .default({ enabled: true, minConfidence: 80 }),
  /** Slack integration */
  slack: z
    .object({
      workspaceId: z.string().optional(),
      channelId: z.string().optional(),
      approverIds: z.string().default(''),
    })
    .default({ approverIds: '' }),
});

export type SreRepoConfig = z.infer<typeof SreRepoConfigSchema>;

// --- Main config schema (just repos[]) ---

/**
 * SRE Agent Config - stored in AdminSettings.
 *
 * Structure: `{ repos[] }`. Each repo is fully self-contained.
 * v1 (flat) configs are transparently migrated via `z.preprocess`.
 */
export const SreAgentConfigSchema = z.preprocess(
  raw => {
    const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

    // Already repos-only shape - pass through
    if (obj.repos) return obj;

    // v1 -> repos-only migration: extract legacy fields into a single repo entry
    const github = (obj.github ?? {}) as Record<string, unknown>;

    const legacyRepo =
      github.owner && github.repo
        ? {
            owner: github.owner as string,
            repo: github.repo as string,
            reviewers: (github.reviewers as string) || '',
            webhookSecret: (github.webhookSecret as string) || '',
            callbackToken: (github.callbackToken as string) || '',
            // All flat v1 fields migrate into the repo entry
            ...(obj.enabled !== undefined ? { enabled: obj.enabled } : {}),
            ...(obj.modelId !== undefined ? { modelId: obj.modelId } : {}),
            ...(obj.maxDiffLines !== undefined ? { maxDiffLines: obj.maxDiffLines } : {}),
            ...(obj.maxFixesPerDay !== undefined ? { maxFixesPerDay: obj.maxFixesPerDay } : {}),
            ...(obj.maxRevisions !== undefined ? { maxRevisions: obj.maxRevisions } : {}),
            ...(obj.dryRun !== undefined ? { dryRun: obj.dryRun } : {}),
            ...(obj.gates ? { gates: obj.gates } : {}),
            ...(obj.circuitBreaker ? { circuitBreaker: obj.circuitBreaker } : {}),
            ...(obj.tokenBudget ? { tokenBudget: obj.tokenBudget } : {}),
            ...(obj.recurrence ? { recurrence: obj.recurrence } : {}),
            ...(obj.patternLibrary ? { patternLibrary: obj.patternLibrary } : {}),
            ...(obj.allowedFilePatterns ? { allowedFilePatterns: obj.allowedFilePatterns } : {}),
            ...(obj.blockedFilePatterns ? { blockedFilePatterns: obj.blockedFilePatterns } : {}),
            ...(obj.sources ? { sources: obj.sources } : {}),
            ...(obj.slack ? { slack: obj.slack } : {}),
          }
        : null;

    return { repos: legacyRepo ? [legacyRepo] : [] };
  },
  z.object({
    repos: z.array(SreRepoConfigSchema).default([]),
  })
);

export type SreAgentConfig = z.infer<typeof SreAgentConfigSchema>;
export type SreGateConfig = z.infer<typeof SreGateConfigSchema>;

/**
 * Resolved repo config - same as SreRepoConfig but with all Zod defaults applied.
 * This is what resolveFullConfig returns (no optionals).
 */
export type ResolvedRepoConfig = SreRepoConfig;

// ============================================
// Config Resolution Helpers
// ============================================

/**
 * Find the repo config for a given repoSlug. Returns null if not configured.
 * Each repo is fully self-contained - no defaults, no inheritance.
 * Base allowed patterns are always merged in.
 */
export function resolveFullConfig(config: SreAgentConfig, repoSlug: string): ResolvedRepoConfig | null {
  const repo = config.repos.find(r => `${r.owner}/${r.repo}` === repoSlug);
  if (!repo) return null;
  // Always merge base allowed patterns
  return {
    ...repo,
    allowedFilePatterns: [...new Set([...SRE_BASE_ALLOWED_PATTERNS, ...repo.allowedFilePatterns])],
  };
}

/**
 * Get all configured repo slugs.
 */
export function getConfiguredRepoSlugs(config: SreAgentConfig): string[] {
  return config.repos.map(r => `${r.owner}/${r.repo}`);
}

/**
 * Resolve the webhook secret for a given repoSlug.
 */
export function resolveWebhookSecret(config: SreAgentConfig, repoSlug: string): string {
  return resolveFullConfig(config, repoSlug)?.webhookSecret ?? '';
}

/**
 * Resolve the callback token for a given repoSlug.
 */
export function resolveCallbackToken(config: SreAgentConfig, repoSlug: string): string {
  return resolveFullConfig(config, repoSlug)?.callbackToken ?? '';
}

// ============================================
// Queue Message Schemas (Zod) - single source of truth
// ============================================
//
// These mirror the interfaces above and were previously defined inline inside
// the individual queue handlers (sreAnalysis.ts, sreRevision.ts). They now live
// here so the merged `sreJobQueue` handler can validate either message shape via
// a single discriminated union. The field sets otherwise match the
// prior handler-local schemas to preserve validation behavior; the one
// deliberate addition is `triggerAction` on SreEventPayloadSchema, which the
// pre-merge handler omitted and thus silently stripped (see the field
// comment below).

/**
 * Diagnosis payload as carried on the wire (revision requests embed it).
 * Named distinctly from `SreDiagnosisSchema` in @bike4mind/services (which validates
 * raw LLM output with min/max bounds + escalate fields) - this is the transport shape.
 */
export const SreWireDiagnosisSchema = z.object({
  rootCause: z.string(),
  proposedFix: z.string(),
  confidence: z.number(),
  riskAssessment: z.string(),
  affectedFiles: z
    .array(
      z.object({
        filePath: z.string(),
        before: z.string(),
        after: z.string(),
        kind: z.enum(['insert', 'replace', 'create']).default('replace'),
      })
    )
    .max(15),
  toolCalls: z
    .array(
      z.object({
        tool: z.string(),
        input: z.record(z.string(), z.unknown()),
        output: z.string(),
      })
    )
    .optional(),
});

/** Analysis job payload (Sentinel -> Diagnostician). */
export const SreEventPayloadSchema = z.object({
  source: z.nativeEnum(SreSourceType),
  fingerprint: z.string(),
  repoSlug: z.string().default(SRE_DEFAULT_REPO_SLUG),
  classification: z.nativeEnum(SreClassification),
  errorMessage: z.string(),
  stackTrace: z.string().optional(),
  functionName: z.string().optional(),
  logGroup: z.string().optional(),
  issueNumber: z.number().optional(),
  issueUrl: z.string().optional(),
  labels: z.array(z.string()).optional(),
  affectedUserIds: z.array(z.string()).optional(),
  dryRun: z.boolean().optional(),
  // Must be declared so it survives parse - producers set it (sreWebhookDispatch),
  // and the Diagnostician reads payload.triggerAction to treat a reopened issue as
  // a stronger "fix didn't work" signal. Omitting it here silently stripped
  // the field on parse, leaving that path dead.
  triggerAction: z.enum(['opened', 'labeled', 'reopened']).optional(),
});

/** Revision job payload (PullRequestReviewHandler -> Diagnostician re-run). */
export const SreRevisionRequestSchema = z.object({
  trackingId: z.string(),
  fingerprint: z.string(),
  repoSlug: z.string().default(SRE_DEFAULT_REPO_SLUG),
  branchName: z.string(),
  prNumber: z.number(),
  reviewBody: z.string().optional(),
  originalDiagnosis: SreWireDiagnosisSchema,
  source: z.nativeEnum(SreSourceType),
  issueNumber: z.number().optional(),
  ciFailureOutput: z.string().optional(),
});

/** Discriminator values for the merged SRE job queue. */
export const SRE_JOB_TYPES = ['analysis', 'revision'] as const;
export type SreJobType = (typeof SRE_JOB_TYPES)[number];

/**
 * Unified message schema for `sreJobQueue`. The `jobType` discriminator selects
 * which payload shape applies; the merged handler switches on it to route to the
 * analysis or revision logic. Analysis and revision share consumer profile and
 * retry policy, so they collapse into one queue. The Fix queue stays
 * separate - it is a downstream dispatch target with a different retry policy.
 */
export const SreJobMessageSchema = z.discriminatedUnion('jobType', [
  SreEventPayloadSchema.extend({ jobType: z.literal('analysis') }),
  SreRevisionRequestSchema.extend({ jobType: z.literal('revision') }),
]);
export type SreJobMessage = z.infer<typeof SreJobMessageSchema>;
export type SreAnalysisJobMessage = Extract<SreJobMessage, { jobType: 'analysis' }>;
export type SreRevisionJobMessage = Extract<SreJobMessage, { jobType: 'revision' }>;
