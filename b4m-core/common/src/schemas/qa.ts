import { z } from 'zod';

/**
 * QA run ingest (admin /status page). The wire schemas are the public contract
 * (api-contract/contracts/qa.contract.ts) and are snake_case per CONVENTIONS.md;
 * the camelCase interfaces are the internal shape the server stores
 * (apps/client/server/qa). scripts/qa-report.mjs mirrors the wire shape because
 * it cannot import TS.
 */

/** Free-form slug, never an enum (public repo). The charset keeps S3 keys safe. */
export const QA_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const QA_EXTERNAL_RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Must match the qaArtifactsBucket lifecycle expiry in infra/buckets.ts. */
export const QA_MEDIA_RETENTION_DAYS = 30;
export const QA_FLAKY_WINDOW = 20;
export const QA_FLAKY_THRESHOLD = 0.15;
export const QA_ERROR_MAX_CHARS = 4000;
export const QA_MAX_TESTS_PER_RUN = 2000;
export const QA_MAX_UPLOADS_PER_CALL = 200;
/**
 * User tag an ingest key's owner must carry, on top of the qa:ingest scope, so
 * only a designated service account can write runs even if an admin mints the
 * scope onto an ordinary user's key.
 */
export const QA_INGEST_USER_TAG = 'qa-ingest';

const MB = 1024 * 1024;
/** Bytes. Mirrored by UPLOAD_LIMITS in scripts/qa-report.mjs. */
export const QA_UPLOAD_LIMITS = {
  screenshot: 5 * MB,
  video: 50 * MB,
  trace: 50 * MB,
  report: 20 * MB,
} as const;

export const QA_UPLOAD_CONTENT_TYPES = {
  screenshot: ['image/png', 'image/jpeg'],
  video: ['video/webm'],
  trace: ['application/zip'],
  report: [
    'text/html',
    'text/css',
    'text/javascript',
    'application/javascript',
    'application/json',
    'application/zip',
    'image/png',
    'image/jpeg',
    'image/svg+xml',
    'video/webm',
    'font/woff',
    'font/woff2',
    'text/plain',
    'application/octet-stream',
  ],
} as const;

export const QaRunStatusSchema = z.enum(['passed', 'failed', 'infra-error']);
export type QaRunStatus = z.infer<typeof QaRunStatusSchema>;
export const QaTestStatusSchema = z.enum(['passed', 'failed', 'flaky', 'skipped', 'notStarted']);
export type QaTestStatus = z.infer<typeof QaTestStatusSchema>;
export const QaRunSourceSchema = z.enum(['ci', 'slack-backfill']);
export type QaRunSource = z.infer<typeof QaRunSourceSchema>;
export const QaArtifactKindSchema = z.enum(['screenshot', 'video', 'trace']);
export type QaArtifactKind = z.infer<typeof QaArtifactKindSchema>;
export const QaUploadKindSchema = z.enum(['screenshot', 'video', 'trace', 'report']);
export type QaUploadKind = z.infer<typeof QaUploadKindSchema>;

const slug = z.string().regex(QA_SLUG_PATTERN);
const externalRunId = z.string().regex(QA_EXTERNAL_RUN_ID_PATTERN);
const count = z.number().int().min(0);

/** Spec-level counts, computed exactly like the jq in .github/workflows/e2e-run.yml. */
export interface QaCounts {
  passed: number;
  failed: number;
  skipped: number;
  notStarted: number;
  /** Non-setup specs with at least one executed result. */
  ran: number;
  total: number;
}

export interface QaSuiteSummary {
  name: string;
  passed: number;
  ran: number;
  notRun: number;
}

export const QaMetricSchema = z.object({
  kind: z.enum(['credits', 'latency']),
  model: z.string().min(1).max(200),
  /** Distinguishes same-model entries with different thresholds (latency spec name). */
  label: z.string().min(1).max(200).optional(),
  value: z.number(),
  unit: z.string().min(1).max(20),
  threshold: z.number().optional(),
});
export type QaMetric = z.infer<typeof QaMetricSchema>;

export const QaArtifactSchema = z.object({
  kind: QaArtifactKindSchema,
  key: z.string().min(1).max(1024),
  bytes: count,
});
export type QaArtifact = z.infer<typeof QaArtifactSchema>;

export interface QaTestResultInput {
  testKey: string;
  title: string;
  status: QaTestStatus;
  durationMs: number;
  retries: number;
  error?: string;
  artifacts: QaArtifact[];
}

/** One run as the server stores it. `startedAt` is ISO 8601. */
export interface QaRunInput {
  product: string;
  tenant?: string;
  suite: string;
  env: string;
  branch: string;
  trigger: string;
  source: QaRunSource;
  ciRunUrl: string;
  sha: string;
  startedAt: string;
  durationMs: number;
  counts: QaCounts;
  suiteSummary: QaSuiteSummary[];
  metrics: QaMetric[];
  reportPrefix?: string;
  externalRunId: string;
  tests: QaTestResultInput[];
}

export const QaCountsIngestSchema = z.object({
  passed: count,
  failed: count,
  skipped: count,
  not_started: count,
  ran: count,
  total: count,
});

export const QaSuiteSummaryIngestSchema = z.object({
  name: z.string().min(1).max(200),
  passed: count,
  ran: count,
  not_run: count,
});

export const QaTestResultIngestSchema = z.object({
  /** Stable identity across runs: spec file plus title path. */
  test_key: z.string().min(1).max(1000),
  title: z.string().min(1).max(1000),
  status: QaTestStatusSchema,
  duration_ms: count,
  retries: count,
  error: z.string().max(QA_ERROR_MAX_CHARS).optional(),
  artifacts: z.array(QaArtifactSchema).max(10).default([]),
});

export const QaRunIngestRequestSchema = z.object({
  product: slug,
  tenant: slug.optional(),
  suite: z.string().min(1).max(100),
  env: z.string().min(1).max(100),
  branch: z.string().min(1).max(255),
  trigger: z.string().min(1).max(100),
  source: QaRunSourceSchema.default('ci'),
  ci_run_url: z.url().max(2048),
  sha: z.string().max(64).default(''),
  started_at: z.iso.datetime(),
  duration_ms: count,
  counts: QaCountsIngestSchema,
  suite_summary: z.array(QaSuiteSummaryIngestSchema).max(200).default([]),
  metrics: z.array(QaMetricSchema).max(500).default([]),
  report_prefix: z.string().max(512).optional(),
  /** GitHub run id + attempt. Idempotency key. */
  external_run_id: externalRunId,
  tests: z.array(QaTestResultIngestSchema).max(QA_MAX_TESTS_PER_RUN).default([]),
});
export type QaRunIngestRequest = z.infer<typeof QaRunIngestRequestSchema>;

export const QaRunIngestResponseSchema = z.object({
  run_id: z.string(),
  status: QaRunStatusSchema,
  created: z.boolean(),
});
export type QaRunIngestResponse = z.infer<typeof QaRunIngestResponseSchema>;

export const QaUploadFileSchema = z.object({
  path: z.string().min(1).max(512),
  kind: QaUploadKindSchema,
  content_type: z.string().min(1).max(100),
  bytes: z.number().int().min(1),
});

export const QaUploadRequestSchema = z.object({
  product: slug,
  external_run_id: externalRunId,
  files: z.array(QaUploadFileSchema).min(1).max(QA_MAX_UPLOADS_PER_CALL),
});
export type QaUploadRequest = z.infer<typeof QaUploadRequestSchema>;

export const QaUploadResponseSchema = z.object({
  uploads: z.array(z.object({ path: z.string(), key: z.string(), url: z.string() })),
  rejected: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export type QaUploadResponse = z.infer<typeof QaUploadResponseSchema>;

/** Wire (snake_case) to the stored shape. Optional fields stay absent rather than undefined. */
export function qaRunFromWire(req: QaRunIngestRequest): QaRunInput {
  return {
    product: req.product,
    ...(req.tenant !== undefined && { tenant: req.tenant }),
    suite: req.suite,
    env: req.env,
    branch: req.branch,
    trigger: req.trigger,
    source: req.source,
    ciRunUrl: req.ci_run_url,
    sha: req.sha,
    startedAt: req.started_at,
    durationMs: req.duration_ms,
    counts: {
      passed: req.counts.passed,
      failed: req.counts.failed,
      skipped: req.counts.skipped,
      notStarted: req.counts.not_started,
      ran: req.counts.ran,
      total: req.counts.total,
    },
    suiteSummary: req.suite_summary.map(s => ({ name: s.name, passed: s.passed, ran: s.ran, notRun: s.not_run })),
    metrics: req.metrics,
    ...(req.report_prefix !== undefined && { reportPrefix: req.report_prefix }),
    externalRunId: req.external_run_id,
    tests: req.tests.map(t => ({
      testKey: t.test_key,
      title: t.title,
      status: t.status,
      durationMs: t.duration_ms,
      retries: t.retries,
      ...(t.error !== undefined && { error: t.error }),
      artifacts: t.artifacts,
    })),
  };
}

/** Spec order: nothing ran, or unstarted specs with no failures, is an environment problem. */
export function deriveRunStatus(counts: Pick<QaCounts, 'failed' | 'notStarted' | 'ran'>): QaRunStatus {
  if (counts.ran === 0) return 'infra-error';
  if (counts.notStarted > 0 && counts.failed === 0) return 'infra-error';
  if (counts.failed > 0) return 'failed';
  return 'passed';
}

/** `statusesNewestFirst`: the test's history, newest first. Skipped/unstarted results do not count. */
export function computeFlakeRate(statusesNewestFirst: readonly QaTestStatus[]): {
  failures: number;
  total: number;
  rate: number;
} {
  const window = statusesNewestFirst.filter(s => s !== 'skipped' && s !== 'notStarted').slice(0, QA_FLAKY_WINDOW);
  const failures = window.filter(s => s === 'failed' || s === 'flaky').length;
  return { failures, total: window.length, rate: window.length ? failures / window.length : 0 };
}

export function isKnownFlaky(statusesNewestFirst: readonly QaTestStatus[]): boolean {
  return computeFlakeRate(statusesNewestFirst).rate >= QA_FLAKY_THRESHOLD;
}

export function qaObjectPrefix(product: string, runId: string, area: 'media' | 'report'): string {
  return `${product}/${runId}/${area}/`;
}

export function isSafeQaPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(path)) return false;
  return !path.split('/').includes('..');
}
