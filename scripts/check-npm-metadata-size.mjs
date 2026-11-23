#!/usr/bin/env node
// Measures the npm metadata document of every package this repo publishes.
//
// The registry rejects a publish once that document passes 100 MB, and the versions that fill
// it cannot be removed afterwards, so the only useful warning is an early one. Run weekly by
// .github/workflows/npm-metadata-size.yml; packages/scripts/src/checkNpmPublishSources.repo.test.ts
// is the static half (it keeps snapshot publishing, the usual cause, out of the workflows).
//
// Restricted packages need NPM_READ_TOKEN (a read-only token). Without it they read as 404,
// which is reported as a failure rather than a pass.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org';
const MB = 1024 * 1024;

export const LIMIT_MB = 100;
export const WARN_MB = 70;
export const FAIL_MB = 90;

const PACKAGE_ROOTS = ['b4m-core', 'packages'];

/** Names of the workspace packages that are published: a publishConfig and not private. */
export function publishablePackages(repoRoot) {
  const names = [];
  for (const root of PACKAGE_ROOTS) {
    const rootDir = path.join(repoRoot, root);
    if (!fs.existsSync(rootDir)) continue;
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      const manifestPath = path.join(rootDir, entry.name, 'package.json');
      if (!entry.isDirectory() || !fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.publishConfig && !manifest.private) names.push(manifest.name);
    }
  }
  return names.sort();
}

/** 'ok' | 'warn' | 'fail' for a metadata document of `bytes`. */
export function classify(bytes) {
  if (bytes >= FAIL_MB * MB) return 'fail';
  if (bytes >= WARN_MB * MB) return 'warn';
  return 'ok';
}

/** Markdown table for the job summary, largest document first; unreadable packages last. */
export function formatReport(rows) {
  const sorted = [...rows].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
  const lines = [
    `| Package | Metadata | Versions | Status |`,
    `|---|---|---|---|`,
    ...sorted.map(row =>
      row.error
        ? `| ${row.name} | - | - | unreadable: ${row.error} |`
        : `| ${row.name} | ${(row.bytes / MB).toFixed(1)} MB | ${row.versions} | ${row.status} |`
    ),
  ];
  return lines.join('\n');
}

// Current 20-package inventory uses at most 400 seconds of asynchronous reads, leaving room
// inside the 15-minute job for setup and reporting. The collection cap also bounds future growth.
export const PACKAGE_TIMEOUT_MS = 20_000;
export const COLLECTION_TIMEOUT_MS = 8 * 60_000;
const TIMEOUT_MESSAGE = 'Metadata read timed out';

function cancelResponseBody(response) {
  if (!response?.body) return;
  void (async () => {
    try {
      await response.body.cancel();
    } catch {
      // Native abort can close/lock the active reader. Disposal is best effort: preserve the
      // primary HTTP/timeout failure instead of replacing it with an already-closed stream error.
    }
  })();
}

/** One absolute deadline covers headers and body. Defaults use native fetch and real abort. */
export async function measure(
  name,
  token,
  { fetch: fetchImpl = globalThis.fetch, deadline = Date.now() + PACKAGE_TIMEOUT_MS } = {}
) {
  if (Date.now() >= deadline) return { name, error: TIMEOUT_MESSAGE };
  const controller = new AbortController();
  const timeoutError = new Error(TIMEOUT_MESSAGE);
  let response;
  let timer;
  const expired = () => controller.signal.aborted || Date.now() >= deadline;
  const throwIfExpired = () => {
    if (!expired()) return;
    controller.abort(timeoutError);
    cancelResponseBody(response);
    throw timeoutError;
  };
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      cancelResponseBody(response);
      reject(timeoutError);
    }, deadline - Date.now());
  });
  const work = (async () => {
    response = await fetchImpl(`${REGISTRY}/${name.replace('/', '%2f')}`, {
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: controller.signal,
    });
    throwIfExpired();
    if (!response.ok) {
      cancelResponseBody(response);
      return { name, error: `HTTP ${response.status}` };
    }
    const body = Buffer.from(await response.arrayBuffer());
    throwIfExpired();
    const versions = Object.keys(JSON.parse(body.toString('utf8')).versions ?? {}).length;
    throwIfExpired();
    return { name, bytes: body.length, versions, status: classify(body.length) };
  })();
  try {
    // Both branches stay observed if a deliberately uncooperative transport settles after timeout.
    return await Promise.race([work, timeout]);
  } catch (error) {
    return { name, error: expired() ? TIMEOUT_MESSAGE : error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Keep every report row, including packages that cannot start before the collection deadline. */
export async function collectMeasurements(
  names,
  token,
  {
    fetch: fetchImpl = globalThis.fetch,
    packageTimeoutMs = PACKAGE_TIMEOUT_MS,
    collectionTimeoutMs = COLLECTION_TIMEOUT_MS,
  } = {}
) {
  const collectionDeadline = Date.now() + collectionTimeoutMs;
  const rows = [];
  for (const name of names) {
    if (Date.now() >= collectionDeadline) {
      rows.push({ name, error: 'Collection read budget exhausted' });
      continue;
    }
    rows.push(
      await measure(name, token, {
        fetch: fetchImpl,
        deadline: Math.min(collectionDeadline, Date.now() + packageTimeoutMs),
      })
    );
  }
  return { rows, failed: rows.some(row => row.error || row.status === 'fail') };
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const names = publishablePackages(repoRoot);
  // Fail closed: no packages means the discovery broke, not that nothing is published.
  if (names.length === 0) {
    console.error('ERROR: found no publishable packages under ' + PACKAGE_ROOTS.join(', ') + '.');
    process.exit(1);
  }

  const token = process.env.NPM_READ_TOKEN;
  const { rows, failed } = await collectMeasurements(names, token);

  const report = formatReport(rows);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## npm metadata size\n\nThe registry limit is ${LIMIT_MB} MB per package. Warn at ${WARN_MB} MB, fail at ${FAIL_MB} MB.\n\n${report}\n`
    );
  }

  const unreadable = rows.filter(row => row.error);
  const failing = rows.filter(row => row.status === 'fail');
  for (const row of rows.filter(r => r.status === 'warn')) {
    console.log(
      `::warning title=npm metadata size::${row.name} is at ${(row.bytes / MB).toFixed(1)} of ${LIMIT_MB} MB.`
    );
  }
  for (const row of failing) {
    console.log(`::error title=npm metadata size::${row.name} is at ${(row.bytes / MB).toFixed(1)} of ${LIMIT_MB} MB.`);
  }
  if (unreadable.length > 0) {
    const hint = token ? 'check the token can read them' : 'NPM_READ_TOKEN is not set';
    console.log(
      `::error title=npm metadata size::could not read ${unreadable.map(row => row.name).join(', ')} (${hint}).`
    );
  }

  if (failed) process.exit(1);
  console.log(`OK: ${rows.length} packages measured, none at or above ${FAIL_MB} MB.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
