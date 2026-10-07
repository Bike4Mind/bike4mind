import { describe, it, expect } from 'vitest';
import {
  computeFlakeRate,
  deriveRunStatus,
  isKnownFlaky,
  isSafeQaPath,
  qaObjectPrefix,
  qaRunFromWire,
  QaRunIngestRequestSchema,
  QaUploadRequestSchema,
  type QaCounts,
  type QaTestStatus,
} from './qa';

const counts = (o: Partial<QaCounts> = {}): QaCounts => ({
  passed: 0,
  failed: 0,
  skipped: 0,
  notStarted: 0,
  ran: 0,
  total: 0,
  ...o,
});
const rep = (s: QaTestStatus, n: number): QaTestStatus[] => Array.from({ length: n }, () => s);

const validRun = {
  product: 'product-a',
  suite: 'Core',
  env: 'staging',
  branch: 'main',
  trigger: 'Run via Deployer',
  ci_run_url: 'https://github.com/example/repo/actions/runs/1',
  started_at: '2026-09-28T09:00:00.000Z',
  duration_ms: 1000,
  counts: { passed: 1, failed: 0, skipped: 0, not_started: 0, ran: 1, total: 1 },
  external_run_id: '1-1',
};

describe('deriveRunStatus', () => {
  it('is infra-error when nothing ran, even if setup failed', () => {
    expect(deriveRunStatus(counts({ ran: 0, failed: 1 }))).toBe('infra-error');
  });
  it('is infra-error when specs did not start and nothing failed', () => {
    expect(deriveRunStatus(counts({ ran: 5, passed: 5, notStarted: 2 }))).toBe('infra-error');
  });
  it('is failed when anything failed, even with unstarted specs', () => {
    expect(deriveRunStatus(counts({ ran: 5, passed: 4, failed: 1, notStarted: 2 }))).toBe('failed');
  });
  it('is passed otherwise', () => {
    expect(deriveRunStatus(counts({ ran: 3, passed: 3 }))).toBe('passed');
  });
});

describe('computeFlakeRate', () => {
  it('counts failed and flaky over the newest 20 results', () => {
    const statuses = [...rep('failed', 4), ...rep('passed', 16), ...rep('failed', 5)];
    expect(computeFlakeRate(statuses)).toEqual({ failures: 4, total: 20, rate: 0.2 });
  });
  it('ignores skipped and notStarted', () => {
    expect(computeFlakeRate(['skipped', 'notStarted', 'flaky', 'passed'])).toEqual({
      failures: 1,
      total: 2,
      rate: 0.5,
    });
  });
  it('is zero with no history', () => {
    expect(computeFlakeRate([])).toEqual({ failures: 0, total: 0, rate: 0 });
  });
  it('tags known flaky at 15 percent or more', () => {
    expect(isKnownFlaky(['failed', ...rep('passed', 5)])).toBe(true);
    expect(isKnownFlaky(['failed', ...rep('passed', 9)])).toBe(false);
  });
});

describe('QaRunIngestRequestSchema', () => {
  it('fills defaults', () => {
    const r = QaRunIngestRequestSchema.parse(validRun);
    expect(r.source).toBe('ci');
    expect(r.sha).toBe('');
    expect(r.tests).toEqual([]);
    expect(r.metrics).toEqual([]);
  });
  it('names the bad field', () => {
    const r = QaRunIngestRequestSchema.safeParse({ ...validRun, product: 'Product A' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['product']);
  });
  it('caps tests per run at 2000', () => {
    const test = { test_key: 'a', title: 'a', status: 'passed', duration_ms: 1, retries: 0 };
    const tests = Array.from({ length: 2001 }, () => test);
    expect(QaRunIngestRequestSchema.safeParse({ ...validRun, tests }).success).toBe(false);
  });
  it('accepts an optional metric label', () => {
    const metrics = [
      { kind: 'latency', model: 'model-x', label: 'short-answers', value: 3.2, unit: 's', threshold: 5 },
    ];
    expect(QaRunIngestRequestSchema.parse({ ...validRun, metrics }).metrics[0]?.label).toBe('short-answers');
  });
});

describe('qaRunFromWire', () => {
  it('maps the snake_case wire onto the stored camelCase shape', () => {
    const wire = QaRunIngestRequestSchema.parse({
      ...validRun,
      counts: { passed: 1, failed: 1, skipped: 0, not_started: 3, ran: 2, total: 2 },
      suite_summary: [{ name: 'Notebook', passed: 1, ran: 2, not_run: 3 }],
      report_prefix: 'product-a/1-1/report/',
      tests: [{ test_key: 'a.spec.ts > a', title: 'a', status: 'failed', duration_ms: 5, retries: 2, error: 'boom' }],
    });
    const run = qaRunFromWire(wire);
    expect(run).toMatchObject({
      ciRunUrl: validRun.ci_run_url,
      startedAt: validRun.started_at,
      durationMs: 1000,
      externalRunId: '1-1',
      reportPrefix: 'product-a/1-1/report/',
      counts: { notStarted: 3, ran: 2 },
      suiteSummary: [{ name: 'Notebook', passed: 1, ran: 2, notRun: 3 }],
      tests: [{ testKey: 'a.spec.ts > a', durationMs: 5, retries: 2, error: 'boom', artifacts: [] }],
    });
  });
  it('leaves absent optionals absent', () => {
    const run = qaRunFromWire(QaRunIngestRequestSchema.parse(validRun));
    expect('tenant' in run).toBe(false);
    expect('reportPrefix' in run).toBe(false);
  });
});

describe('QaUploadRequestSchema', () => {
  it('requires at least one file', () => {
    expect(QaUploadRequestSchema.safeParse({ product: 'product-a', external_run_id: '1-1', files: [] }).success).toBe(
      false
    );
  });
});

describe('paths', () => {
  it('builds run-scoped prefixes', () => {
    expect(qaObjectPrefix('product-a', '1-1', 'media')).toBe('product-a/1-1/media/');
    expect(qaObjectPrefix('product-a', '1-1', 'report')).toBe('product-a/1-1/report/');
  });
  it('rejects traversal, absolute, backslash and control characters', () => {
    expect(isSafeQaPath('data/a.png')).toBe(true);
    for (const bad of ['../x', 'a/../../x', '/x', 'a\\b', 'a\nb', '']) expect(isSafeQaPath(bad)).toBe(false);
  });
});
