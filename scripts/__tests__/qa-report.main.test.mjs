import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FETCH_TIMEOUT_MS, main } from '../qa-report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV = {
  QA_INGEST_URL: 'https://app.example.com/',
  QA_INGEST_KEY: 'b4m_test_key',
  QA_PRODUCT: 'product-a',
  QA_SUITE: 'Core',
  QA_ENV: 'Staging',
  QA_TRIGGER: 'Run via Deployer',
  GITHUB_RUN_ID: '100',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_REPOSITORY: 'example/repo',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_SHA: 'abc123',
  GITHUB_REF_NAME: 'main',
};
const noSleep = async () => {};
const makeLog = () => ({ log: vi.fn(), warn: vi.fn() });
// The slice of fetch's Response that qa-report.mjs reads.
const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

let dir;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-report-'));
});

async function writeFixture({ passing = false } = {}) {
  const raw = (await fs.readFile(path.join(here, 'fixtures/pw-results.json'), 'utf8')).replaceAll('__ATTACH__', dir);
  const report = JSON.parse(raw);
  if (passing) report.stats.unexpected = 0;
  await fs.writeFile(path.join(dir, 'pw-results.json'), JSON.stringify(report));
  await fs.writeFile(path.join(dir, 'shot.png'), 'png-bytes');
  await fs.writeFile(path.join(dir, 'video.webm'), 'webm-bytes');
  await fs.writeFile(path.join(dir, 'trace.zip'), 'zip-bytes');
  await fs.mkdir(path.join(dir, 'report/data'), { recursive: true });
  await fs.writeFile(path.join(dir, 'report/index.html'), '<html></html>');
  await fs.writeFile(path.join(dir, 'report/data/a.png'), 'png');
}

function fakeFetch({ runs } = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, init = {}) => {
    calls.push({ url, init });
    if (url === 'https://app.example.com/api/qa/uploads') {
      const body = JSON.parse(init.body);
      return json(200, {
        uploads: body.files.map(f => ({
          path: f.path,
          key: `product-a/100-1/${f.kind === 'report' ? 'report' : 'media'}/${f.path}`,
          url: `https://s3.example/${f.path}`,
        })),
        rejected: [],
      });
    }
    if (url.startsWith('https://s3.example/')) return json(200, null);
    if (url === 'https://app.example.com/api/qa/runs') {
      return runs ? runs() : json(200, { run_id: 'r1', status: 'failed', created: true });
    }
    throw new Error(`unexpected ${url}`);
  });
  return { fetch, calls };
}
const bodyOf = (calls, suffix) => JSON.parse(calls.find(c => c.url.endsWith(suffix)).init.body);
const runBody = calls => bodyOf(calls, '/api/qa/runs');

describe('main', () => {
  it('posts an infra-error run when no results file exists', async () => {
    const { fetch, calls } = fakeFetch();
    expect(
      await main(['--results', path.join(dir, 'missing.json')], ENV, { fetch, sleep: noSleep, log: makeLog() })
    ).toBe(0);
    const body = runBody(calls);
    expect(body.counts).toEqual({ passed: 0, failed: 0, skipped: 0, not_started: 0, ran: 0, total: 0 });
    expect(body).toMatchObject({
      product: 'product-a',
      suite: 'Core',
      env: 'staging',
      branch: 'main',
      source: 'ci',
      sha: 'abc123',
      external_run_id: '100-1',
      ci_run_url: 'https://github.com/example/repo/actions/runs/100',
    });
    expect(body).not.toHaveProperty('tenant');
    expect(calls.some(c => c.url.endsWith('/api/qa/uploads'))).toBe(false);
  });

  it('uploads failure media and the report, then posts artifact keys', async () => {
    await writeFixture();
    const { fetch, calls } = fakeFetch();
    await main(['--results', path.join(dir, 'pw-results.json'), '--report-dir', path.join(dir, 'report')], ENV, {
      fetch,
      sleep: noSleep,
      log: makeLog(),
    });
    const puts = calls
      .filter(c => c.init.method === 'PUT')
      .map(c => c.url)
      .sort();
    expect(puts).toEqual([
      'https://s3.example/data/a.png',
      'https://s3.example/index.html',
      'https://s3.example/test-2/shot.png',
      'https://s3.example/test-2/trace.zip',
      'https://s3.example/test-2/video.webm',
    ]);
    const uploadBody = bodyOf(calls, '/api/qa/uploads');
    expect(uploadBody).toMatchObject({ product: 'product-a', external_run_id: '100-1' });
    expect(uploadBody.files[0]).toEqual({
      path: 'test-2/shot.png',
      kind: 'screenshot',
      content_type: 'image/png',
      bytes: 9,
    });
    const body = runBody(calls);
    const saves = body.tests.find(t => t.test_key.endsWith('saves'));
    expect(saves.artifacts).toEqual([
      { kind: 'screenshot', key: 'product-a/100-1/media/test-2/shot.png', bytes: 9 },
      { kind: 'video', key: 'product-a/100-1/media/test-2/video.webm', bytes: 10 },
      { kind: 'trace', key: 'product-a/100-1/media/test-2/trace.zip', bytes: 9 },
    ]);
    expect(saves).toMatchObject({ status: 'failed', duration_ms: 9000, retries: 2 });
    expect(body.report_prefix).toBe('product-a/100-1/report/');
    expect(body.suite_summary[0]).toEqual({ name: 'Notebook', passed: 3, ran: 4, not_run: 0 });
    expect(body.tests.every(t => !('attachments' in t))).toBe(true);
  });

  it('skips uploads for a run with no failures', async () => {
    await writeFixture({ passing: true });
    const { fetch, calls } = fakeFetch();
    await main(['--results', path.join(dir, 'pw-results.json'), '--report-dir', path.join(dir, 'report')], ENV, {
      fetch,
      sleep: noSleep,
      log: makeLog(),
    });
    expect(calls.map(c => c.url)).toEqual(['https://app.example.com/api/qa/runs']);
    expect(runBody(calls).report_prefix).toBeUndefined();
  });

  it('retries 3 times, then warns and exits 0', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const log = makeLog();
    expect(await main([], ENV, { fetch, sleep: noSleep, log })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('::warning::'));
  });

  it('gives every request its own timeout signal, 60s by default', async () => {
    await writeFixture();
    const { fetch, calls } = fakeFetch();
    await main(['--results', path.join(dir, 'pw-results.json'), '--report-dir', path.join(dir, 'report')], ENV, {
      fetch,
      sleep: noSleep,
      log: makeLog(),
    });
    expect(FETCH_TIMEOUT_MS).toBe(60_000);
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.every(c => c.init.signal instanceof AbortSignal)).toBe(true);
    expect(new Set(calls.map(c => c.init.signal)).size).toBe(calls.length);
  });

  // A hung first attempt must not outlive its retry, or both can ingest the run at once.
  it('aborts a hung ingest POST at the timeout and retries it', async () => {
    let attempt = 0;
    const fetch = vi.fn((url, init) => {
      attempt += 1;
      if (attempt > 1) return Promise.resolve(json(200, { run_id: 'r1', status: 'passed', created: false }));
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)));
    });
    const log = makeLog();
    expect(await main([], ENV, { fetch, sleep: noSleep, log, fetchTimeoutMs: 20 })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('qa-report: run r1'));
  });

  it('aborts a hung artifact PUT at its timeout and retries it', async () => {
    await writeFixture();
    const { fetch: base, calls } = fakeFetch();
    let hung = false;
    const fetch = vi.fn((url, init) => {
      if (!hung && url === 'https://s3.example/test-2/shot.png') {
        hung = true;
        return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)));
      }
      return base(url, init);
    });
    await main(['--results', path.join(dir, 'pw-results.json'), '--report-dir', path.join(dir, 'report')], ENV, {
      fetch,
      sleep: noSleep,
      log: makeLog(),
      uploadTimeoutMs: 20,
    });
    const saves = runBody(calls).tests.find(t => t.test_key.endsWith('saves'));
    expect(saves.artifacts.map(a => a.kind)).toEqual(['screenshot', 'video', 'trace']);
  });

  it('does not retry a 422', async () => {
    const { fetch } = fakeFetch({ runs: () => json(422, { error: 'Validation error at "product"' }) });
    expect(await main([], ENV, { fetch, sleep: noSleep, log: makeLog() })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('skips ingest when config is missing', async () => {
    const fetch = vi.fn();
    const log = makeLog();
    expect(await main([], {}, { fetch, sleep: noSleep, log })).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('QA_INGEST_URL'));
  });

  it('writes the counts file for the shadow comparison', async () => {
    await writeFixture();
    const { fetch } = fakeFetch();
    const out = path.join(dir, 'qa-counts.json');
    await main(['--results', path.join(dir, 'pw-results.json'), '--counts-out', out], ENV, {
      fetch,
      sleep: noSleep,
      log: makeLog(),
    });
    expect(JSON.parse(await fs.readFile(out, 'utf8'))).toEqual({
      passed: 3,
      failed: 1,
      skipped: 0,
      notStarted: 1,
      ran: 4,
      total: 4,
    });
  });

  it('merges a downloaded matrix with per-artifact labels and latency metrics', async () => {
    const report = JSON.parse(await fs.readFile(path.join(here, 'fixtures/pw-results.json'), 'utf8'));
    report.stats.unexpected = 0;
    for (const cell of ['cell-a', 'cell-b']) {
      await fs.mkdir(path.join(dir, 'dl', cell, 'playwright-report'), { recursive: true });
      await fs.mkdir(path.join(dir, 'dl', cell, 'e2e/test-results/ai-latency'), { recursive: true });
      await fs.writeFile(path.join(dir, 'dl', cell, 'playwright-report/spec-pw-results.json'), JSON.stringify(report));
      await fs.writeFile(
        path.join(dir, 'dl', cell, 'e2e/test-results/ai-latency/ai-latency-short-answers-results.json'),
        JSON.stringify({ model: `model-${cell}`, thresholdSec: 5, averageResponseTimeSec: 2.5 })
      );
    }
    const { fetch, calls } = fakeFetch();
    await main(
      ['--results-dir', path.join(dir, 'dl'), '--latency-dir', path.join(dir, 'dl')],
      { ...ENV, QA_SUITE: 'AI Latency' },
      { fetch, sleep: noSleep, log: makeLog() }
    );
    const body = runBody(calls);
    expect(body.counts.ran).toBe(8);
    expect(body.tests[0].test_key).toBe('cell-a::core.setup.ts > create admin');
    expect(body.metrics.map(m => [m.model, m.label])).toEqual([
      ['model-cell-a', 'ai-latency-short-answers'],
      ['model-cell-b', 'ai-latency-short-answers'],
    ]);
  });
});
