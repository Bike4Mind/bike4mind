#!/usr/bin/env node
/**
 * Refresh packages/cli/test/baseline.json after an intentional bundle change.
 *
 * Usage:
 *   pnpm --filter @bike4mind/cli build
 *   node packages/cli/test/scripts/refresh-baseline.mjs
 *
 * Reads the current dist/, recomputes total bytes + file count, writes them
 * back to baseline.json. Tolerances and metadata are preserved.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, '..', '..');
const distDir = join(cliRoot, 'dist');
const baselinePath = join(cliRoot, 'test', 'baseline.json');

if (!existsSync(distDir)) {
  console.error(`error: ${distDir} does not exist. Run \`pnpm --filter @bike4mind/cli build\` first.`);
  process.exit(1);
}

function listJsFiles(dir) {
  const out = [];
  const walk = d => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const files = listJsFiles(distDir);
const totalBytes = files.reduce((sum, f) => sum + statSync(f).size, 0);
const fileCount = files.length;

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const before = { totalBytes: baseline.bundle.totalBytes, fileCount: baseline.bundle.fileCount };

baseline.bundle.totalBytes = totalBytes;
baseline.bundle.fileCount = fileCount;
baseline._recordedAt = new Date().toISOString().slice(0, 10);
try {
  baseline._recordedAfterCommit = execSync('git rev-parse --short HEAD', { cwd: cliRoot }).toString().trim();
} catch {
  // git not available - leave field as-is
}

writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');

console.log('Baseline refreshed:');
console.log(
  `  totalBytes:  ${before.totalBytes.toLocaleString()} → ${totalBytes.toLocaleString()} ` +
    `(${(((totalBytes - before.totalBytes) / before.totalBytes) * 100).toFixed(1)}%)`
);
console.log(`  fileCount:   ${before.fileCount} → ${fileCount} (delta ${fileCount - before.fileCount})`);
