#!/usr/bin/env node
/**
 * Post-run QA ingest for the admin /status page (routes: apps/client/pages/api/qa/,
 * wire schemas: b4m-core/common/src/schemas/qa.ts).
 *
 * Reads Playwright's JSON report (plus optional metrics), uploads failure media
 * and the HTML report through presigned PUTs, then posts the run. Zero
 * dependencies so another repo can run it from a pinned raw URL. Never fails
 * the calling job: every error ends in a ::warning:: and exit 0.
 *
 * Parsing works in camelCase; only the request bodies are snake_case, matching
 * the wire schemas (QaRunIngestRequestSchema, QaUploadRequestSchema).
 *
 * Counting mirrors the "Parse test results" jq in .github/workflows/e2e-run.yml;
 * keep the two in sync while that step exists.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MB = 1024 * 1024;
/** Mirrors QA_UPLOAD_LIMITS in b4m-core/common/src/schemas/qa.ts. */
export const UPLOAD_LIMITS = { screenshot: 5 * MB, video: 50 * MB, trace: 50 * MB, report: 20 * MB };
export const ERROR_MAX_CHARS = 4000;
export const MAX_TESTS = 2000;
/** Mirrors CREDITS_THRESHOLD in apps/client/e2e/helpers/slack.ts. */
export const CREDITS_THRESHOLD = 60;

const MEDIA_KINDS = new Set(['screenshot', 'video', 'trace']);
const SETUP_FILE = /\.setup\.ts$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

export const contentTypeFor = file => CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

const hasRun = test => (test.results ?? []).length > 0;

function collectSpecs(suite, out = []) {
  for (const spec of suite.specs ?? []) out.push(spec);
  for (const child of suite.suites ?? []) collectSpecs(child, out);
  return out;
}

export function suiteDisplayName(title) {
  const raw = title.replace(/e2e\//g, '').replace(/\.spec\.ts$/, '');
  return raw
    .split('-')
    .flatMap(part => part.split('_'))
    .map(word => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(' ');
}

function mapStatus(test) {
  if (!hasRun(test)) return 'notStarted';
  if (test.status === 'expected') return 'passed';
  if (test.status === 'unexpected') return 'failed';
  if (test.status === 'flaky') return 'flaky';
  return 'skipped';
}

export function cleanError(result) {
  const raw = result?.errors?.[0]?.message ?? result?.error?.message;
  if (!raw) return undefined;
  const text = String(raw).replace(ANSI, '');
  return text.length > ERROR_MAX_CHARS ? `${text.slice(0, ERROR_MAX_CHARS - 3)}...` : text;
}

const isTrace = a => a.name === 'trace' && a.path;

function failureMedia(results) {
  const media = (results[results.length - 1]?.attachments ?? []).filter(a => a.path && MEDIA_KINDS.has(a.name));
  if (media.some(isTrace)) return media;
  // playwright.config.ts records traces 'on-first-retry', so a test that fails every attempt
  // has its trace on an earlier attempt, never the last one.
  const trace = results.findLast(r => (r.attachments ?? []).some(isTrace))?.attachments.find(isTrace);
  return trace ? [...media, trace] : media;
}

function walkTests(suite, titles, file, label, out) {
  for (const spec of suite.specs ?? []) {
    const title = [...titles, spec.title].join(' > ');
    for (const test of spec.tests ?? []) {
      const results = test.results ?? [];
      const last = results[results.length - 1];
      const project = spec.tests.length > 1 && test.projectName ? ` [${test.projectName}]` : '';
      const status = mapStatus(test);
      const errorSource = status === 'flaky' ? results.find(r => r.status !== 'passed') : last;
      out.push({
        testKey: `${label ? `${label}::` : ''}${file} > ${title}${project}`,
        title: `${title}${project}`,
        status,
        durationMs: Math.round(results.reduce((sum, r) => sum + (r.duration ?? 0), 0)),
        retries: Math.max(0, results.length - 1),
        error: status === 'failed' || status === 'flaky' ? cleanError(errorSource) : undefined,
        artifacts: [],
        // Local file paths; stripped before posting.
        attachments: status === 'failed' ? failureMedia(results) : [],
      });
    }
  }
  for (const child of suite.suites ?? []) walkTests(child, [...titles, child.title], file, label, out);
}

export function parseResults(json, { label } = {}) {
  const counts = { passed: 0, failed: json?.stats?.unexpected ?? 0, skipped: 0, notStarted: 0, ran: 0, total: 0 };
  const suiteSummary = [];
  const tests = [];
  for (const top of json?.suites ?? []) {
    walkTests(top, [], top.file ?? top.title, label, tests);
    if (SETUP_FILE.test(top.title)) continue;
    const specs = collectSpecs(top);
    const ran = specs.filter(s => (s.tests ?? []).some(hasRun));
    const passed = ran.filter(s => s.ok === true).length;
    const notRun = specs.filter(s => (s.tests ?? []).length > 0 && s.tests.every(t => !hasRun(t))).length;
    counts.passed += passed;
    counts.ran += ran.length;
    counts.notStarted += notRun;
    suiteSummary.push({
      name: `${label ? `${label} ` : ''}${suiteDisplayName(top.title)}`,
      passed,
      ran: ran.length,
      notRun,
    });
  }
  // Same clamp as the jq: FAILED includes setup failures that are not in `ran`.
  counts.skipped = Math.max(0, counts.ran - counts.passed - counts.failed);
  counts.total = counts.passed + counts.skipped + counts.failed;
  const startMs = Date.parse(json?.stats?.startTime ?? '') || Date.now();
  return { tests, counts, suiteSummary, startMs, endMs: startMs + (json?.stats?.duration ?? 0) };
}

export function mergeParsed(parts) {
  const counts = { passed: 0, failed: 0, skipped: 0, notStarted: 0, ran: 0, total: 0 };
  for (const part of parts) for (const key of Object.keys(counts)) counts[key] += part.counts[key];
  return {
    tests: parts.flatMap(p => p.tests),
    counts,
    suiteSummary: parts.flatMap(p => p.suiteSummary),
    startMs: Math.min(...parts.map(p => p.startMs)),
    endMs: Math.max(...parts.map(p => p.endMs)),
  };
}

export function capTests(tests, max = MAX_TESTS) {
  if (tests.length <= max) return tests;
  const notPassed = tests.filter(t => t.status !== 'passed');
  const passed = tests.filter(t => t.status === 'passed');
  return [...notPassed, ...passed].slice(0, max);
}

export function isMetric(m) {
  return (
    m &&
    (m.kind === 'credits' || m.kind === 'latency') &&
    typeof m.model === 'string' &&
    typeof m.value === 'number' &&
    Number.isFinite(m.value) &&
    typeof m.unit === 'string'
  );
}

export function creditsMetrics(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter(e => typeof e?.model === 'string' && typeof e.avgCredits === 'number')
    .map(e => ({
      kind: 'credits',
      model: e.model,
      value: e.avgCredits,
      unit: 'credits',
      threshold: CREDITS_THRESHOLD,
    }));
}

/** 0 means "no data" in e2e-ai-latency.yml's Aggregate step. */
export function latencyMetric(fileName, json) {
  const avg = json?.averageResponseTimeSec;
  if (typeof avg !== 'number' || avg <= 0 || typeof json.model !== 'string') return null;
  const metric = {
    kind: 'latency',
    model: json.model,
    label: path.basename(fileName, '-results.json'),
    value: avg,
    unit: 's',
  };
  if (typeof json.thresholdSec === 'number') metric.threshold = json.thresholdSec;
  return metric;
}

const UPLOAD_BATCH = 200; // QA_MAX_UPLOADS_PER_CALL
const REPORT_MAX_FILES = 1000;
const PUT_CONCURRENCY = 8;
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Per attempt, so a hung attempt is abandoned before its retry rather than racing it. The API
// call matches the server's 60s Lambda timeout; an artifact PUT carries up to 50 MB.
export const FETCH_TIMEOUT_MS = 60_000;
export const UPLOAD_TIMEOUT_MS = 5 * 60_000;

function httpError(what, status, detail = '') {
  const err = new Error(`${what} -> HTTP ${status} ${detail}`.trim().slice(0, 500));
  // 4xx other than 429 will not change on retry.
  err.retryable = status >= 500 || status === 429;
  return err;
}

export async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, sleep = defaultSleep, log = console } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err?.retryable === false || attempt === attempts) break;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  log.warn(`::warning::qa-report: ${lastErr?.message ?? lastErr}`);
  return null;
}

async function postJson(fetchImpl, url, apiKey, body, timeoutMs = FETCH_TIMEOUT_MS) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw httpError(`POST ${url}`, res.status, await res.text().catch(() => ''));
  return res.json();
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

async function fileSize(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

async function readJson(file, log) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    log.log(`qa-report: cannot read ${file}: ${err.code ?? err.message}`);
    return null;
  }
}

async function findFiles(dir, match) {
  try {
    const entries = await fs.readdir(dir, { recursive: true });
    return entries
      .filter(entry => match(path.basename(entry)))
      .map(entry => path.join(dir, entry))
      .sort();
  } catch {
    return [];
  }
}

export function parseArgs(argv) {
  const args = { results: [] };
  const single = {
    '--results-dir': 'resultsDir',
    '--report-dir': 'reportDir',
    '--credits': 'credits',
    '--latency-dir': 'latencyDir',
    '--metrics': 'metrics',
    '--counts-out': 'countsOut',
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === '--results') args.results.push(value);
    else if (single[flag]) args[single[flag]] = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

async function expandResults(args) {
  const out = args.results.map(entry => {
    const eq = entry.indexOf('=');
    return eq > 0 && !entry.slice(0, eq).includes('/')
      ? { label: entry.slice(0, eq), file: entry.slice(eq + 1) }
      : { file: entry };
  });
  if (args.resultsDir) {
    // Only the per-spec copies: e2e-ai-latency.yml can also leave the original pw-results.json next to them.
    for (const file of await findFiles(args.resultsDir, name => name.endsWith('-pw-results.json'))) {
      out.push({ label: path.relative(args.resultsDir, file).split(path.sep)[0], file });
    }
  }
  return out;
}

async function loadMetrics(args, log) {
  const metrics = [];
  if (args.metrics) {
    const normalized = await readJson(args.metrics, log);
    if (Array.isArray(normalized)) metrics.push(...normalized.filter(isMetric));
  }
  if (args.credits) metrics.push(...creditsMetrics(await readJson(args.credits, log)));
  if (args.latencyDir) {
    const files = await findFiles(args.latencyDir, n => n.endsWith('-results.json') && !n.endsWith('-pw-results.json'));
    for (const file of files) {
      const metric = latencyMetric(file, await readJson(file, log));
      if (metric) metrics.push(metric);
    }
  }
  return metrics.slice(0, 500);
}

export function resolveIdentity(env) {
  const runId = env.GITHUB_RUN_ID;
  return {
    product: env.QA_PRODUCT,
    tenant: env.QA_TENANT || undefined,
    suite: env.QA_SUITE || 'Full',
    env: (env.QA_ENV || 'unknown').toLowerCase(),
    branch: env.QA_BRANCH || env.GITHUB_REF_NAME || 'unknown',
    trigger: env.QA_TRIGGER || env.GITHUB_EVENT_NAME || 'unknown',
    ciRunUrl:
      env.QA_CI_RUN_URL ||
      (runId ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${runId}` : ''),
    sha: env.QA_SHA || env.GITHUB_SHA || '',
    externalRunId: env.QA_EXTERNAL_RUN_ID || (runId ? `${runId}-${env.GITHUB_RUN_ATTEMPT || '1'}` : ''),
  };
}

export async function collectUploads({ tests, reportDir, log = console }) {
  const files = [];
  for (const [testIndex, test] of tests.entries()) {
    for (const a of test.attachments) {
      const bytes = await fileSize(a.path);
      if (!bytes) {
        log.log(`qa-report: attachment missing or empty, skipped: ${a.path}`);
      } else if (bytes > UPLOAD_LIMITS[a.name]) {
        log.warn(`::warning::qa-report: ${a.name} ${a.path} is ${bytes} bytes (cap ${UPLOAD_LIMITS[a.name]}), skipped`);
      } else {
        files.push({
          path: `test-${testIndex}/${path.basename(a.path)}`,
          kind: a.name,
          contentType: a.contentType || contentTypeFor(a.path),
          bytes,
          localPath: a.path,
          testIndex,
        });
      }
    }
  }
  if (reportDir) {
    const all = await findFiles(reportDir, () => true);
    const regular = [];
    for (const localPath of all) {
      const bytes = await fileSize(localPath);
      if (bytes) regular.push({ localPath, bytes });
    }
    if (regular.length > REPORT_MAX_FILES) {
      log.warn(`::warning::qa-report: report has ${regular.length} files, uploading ${REPORT_MAX_FILES}`);
    }
    for (const { localPath, bytes } of regular.slice(0, REPORT_MAX_FILES)) {
      if (bytes > UPLOAD_LIMITS.report) continue;
      files.push({
        path: path.relative(reportDir, localPath).split(path.sep).join('/'),
        kind: 'report',
        contentType: contentTypeFor(localPath),
        bytes,
        localPath,
      });
    }
  }
  return files;
}

export async function uploadFiles({
  files,
  ingestUrl,
  apiKey,
  product,
  externalRunId,
  fetchImpl,
  retry,
  log,
  timeoutMs = FETCH_TIMEOUT_MS,
  uploadTimeoutMs = UPLOAD_TIMEOUT_MS,
}) {
  const uploaded = new Map();
  for (let i = 0; i < files.length; i += UPLOAD_BATCH) {
    const batch = files.slice(i, i + UPLOAD_BATCH);
    const plan = await retry(() =>
      postJson(
        fetchImpl,
        `${ingestUrl}/api/qa/uploads`,
        apiKey,
        {
          product,
          external_run_id: externalRunId,
          files: batch.map(({ path: p, kind, contentType, bytes }) => ({
            path: p,
            kind,
            content_type: contentType,
            bytes,
          })),
        },
        timeoutMs
      )
    );
    if (!plan) break;
    for (const r of plan.rejected ?? []) log.warn(`::warning::qa-report: upload rejected ${r.path}: ${r.reason}`);
    const byPath = new Map(batch.map(f => [f.path, f]));
    await mapLimit(plan.uploads ?? [], PUT_CONCURRENCY, async upload => {
      const file = byPath.get(upload.path);
      if (!file) return;
      const ok = await retry(async () => {
        const res = await fetchImpl(upload.url, {
          method: 'PUT',
          headers: { 'Content-Type': file.contentType },
          body: await fs.readFile(file.localPath),
          signal: AbortSignal.timeout(uploadTimeoutMs),
        });
        if (!res.ok) throw httpError(`PUT ${upload.path}`, res.status);
        return true;
      });
      if (ok) uploaded.set(upload.path, upload.key);
    });
  }
  return uploaded;
}

/** The snake_case body QaRunIngestRequestSchema validates. */
export function buildRunPayload({ identity, parsed, metrics, reportPrefix }) {
  const { counts } = parsed;
  const payload = {
    product: identity.product,
    suite: identity.suite,
    env: identity.env,
    branch: identity.branch,
    trigger: identity.trigger,
    source: 'ci',
    ci_run_url: identity.ciRunUrl,
    sha: identity.sha,
    started_at: new Date(parsed.startMs).toISOString(),
    duration_ms: Math.max(0, Math.round(parsed.endMs - parsed.startMs)),
    counts: {
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
      not_started: counts.notStarted,
      ran: counts.ran,
      total: counts.total,
    },
    suite_summary: parsed.suiteSummary
      .slice(0, 200)
      .map(s => ({ name: s.name, passed: s.passed, ran: s.ran, not_run: s.notRun })),
    metrics,
    external_run_id: identity.externalRunId,
    tests: capTests(parsed.tests).map(t => {
      const test = {
        test_key: t.testKey,
        title: t.title,
        status: t.status,
        duration_ms: t.durationMs,
        retries: t.retries,
        artifacts: t.artifacts,
      };
      if (t.error !== undefined) test.error = t.error;
      return test;
    }),
  };
  if (identity.tenant) payload.tenant = identity.tenant;
  if (reportPrefix) payload.report_prefix = reportPrefix;
  return payload;
}

export async function main(argv, env, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? console;
  const retry = fn => withRetry(fn, { sleep: deps.sleep, log });
  const timeoutMs = deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  const uploadTimeoutMs = deps.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;
  try {
    const args = parseArgs(argv);
    const ingestUrl = (env.QA_INGEST_URL || '').replace(/\/+$/, '');
    const identity = resolveIdentity(env);
    if (!ingestUrl || !env.QA_INGEST_KEY || !identity.product || !identity.externalRunId || !identity.ciRunUrl) {
      log.warn(
        '::warning::qa-report: QA_INGEST_URL, QA_INGEST_KEY, QA_PRODUCT or GITHUB_RUN_ID unset; skipping ingest'
      );
      return 0;
    }

    const parts = [];
    for (const { label, file } of await expandResults(args)) {
      const report = await readJson(file, log);
      if (report) parts.push(parseResults(report, { label }));
    }
    // No results file means the job died before Playwright reported: still post it (infra-error).
    const parsed = parts.length > 0 ? mergeParsed(parts) : parseResults({});
    if (args.countsOut) await fs.writeFile(args.countsOut, JSON.stringify(parsed.counts));

    const metrics = await loadMetrics(args, log);
    let reportPrefix;
    if (parsed.counts.failed > 0) {
      const files = await collectUploads({ tests: parsed.tests, reportDir: args.reportDir, log });
      const uploaded = await uploadFiles({
        files,
        ingestUrl,
        apiKey: env.QA_INGEST_KEY,
        product: identity.product,
        externalRunId: identity.externalRunId,
        fetchImpl,
        retry,
        log,
        timeoutMs,
        uploadTimeoutMs,
      });
      for (const file of files) {
        const key = uploaded.get(file.path);
        if (key && file.kind !== 'report')
          parsed.tests[file.testIndex].artifacts.push({ kind: file.kind, key, bytes: file.bytes });
      }
      if (uploaded.has('index.html')) reportPrefix = `${identity.product}/${identity.externalRunId}/report/`;
    }

    const payload = buildRunPayload({ identity, parsed, metrics, reportPrefix });
    const result = await retry(() =>
      postJson(fetchImpl, `${ingestUrl}/api/qa/runs`, env.QA_INGEST_KEY, payload, timeoutMs)
    );
    if (result) log.log(`qa-report: run ${result.run_id} status=${result.status} created=${result.created}`);
    return 0;
  } catch (err) {
    log.warn(`::warning::qa-report: ${err?.message ?? err}`);
    return 0;
  }
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main(process.argv.slice(2), process.env).then(code => process.exit(code));
