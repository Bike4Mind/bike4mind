/**
 * E2E test: structural baselines.
 *
 * Detects bundle-size and file-count regressions between commits during
 * the Q1 decomposition. Fails noisily if a refactor accidentally pulls
 * in a heavy dependency or proliferates chunk files.
 *
 * Skips cleanly if dist/ doesn't exist - `pnpm test:e2e` shouldn't force
 * a build. CI builds first, then runs e2e.
 *
 * To refresh after an intentional size change, run:
 *   pnpm --filter @bike4mind/cli build
 *   node packages/cli/test/scripts/refresh-baseline.mjs
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliRoot = join(__dirname, '..', '..');
const distDir = join(cliRoot, 'dist');
const baselinePath = join(cliRoot, 'test', 'baseline.json');

interface Baseline {
  bundle: {
    totalBytes: number;
    fileCount: number;
    tolerance: {
      totalGrowthFraction: number;
      fileCountDelta: number;
    };
  };
}

function listJsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe('e2e — structural baselines', () => {
  const distExists = existsSync(distDir);

  it.skipIf(!distExists)('bundle total size is within tolerance of baseline', () => {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
    const files = listJsFiles(distDir);
    const totalBytes = files.reduce((sum, f) => sum + statSync(f).size, 0);

    const max = baseline.bundle.totalBytes * (1 + baseline.bundle.tolerance.totalGrowthFraction);
    expect(
      totalBytes,
      `Bundle grew from ${baseline.bundle.totalBytes} to ${totalBytes} ` +
        `(${(((totalBytes - baseline.bundle.totalBytes) / baseline.bundle.totalBytes) * 100).toFixed(1)}%). ` +
        `Tolerance: +${(baseline.bundle.tolerance.totalGrowthFraction * 100).toFixed(0)}%. ` +
        `If intentional, refresh baseline.json.`
    ).toBeLessThanOrEqual(max);
  });

  it.skipIf(!distExists)('chunk-file count is stable within tolerance', () => {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
    const fileCount = listJsFiles(distDir).length;
    const delta = Math.abs(fileCount - baseline.bundle.fileCount);

    expect(
      delta,
      `File count moved from ${baseline.bundle.fileCount} to ${fileCount} ` +
        `(delta ${delta}, tolerance ±${baseline.bundle.tolerance.fileCountDelta}). ` +
        `If intentional, refresh baseline.json.`
    ).toBeLessThanOrEqual(baseline.bundle.tolerance.fileCountDelta);
  });

  // In CI the build runs before the harness, so dist/ must exist - otherwise
  // the two bundle checks above would silently skip and a size regression
  // could land green. Locally (no CI) the skip is fine. This guard fails loudly
  // if the CI ordering ever regresses so the build step is dropped.
  it('dist/ exists in CI so the bundle checks are not silently skipped', () => {
    if (process.env.CI) {
      expect(
        distExists,
        'packages/cli/dist/ missing in CI — build the CLI before running test:e2e ' +
          '(see the "Build CLI" step in .github/workflows/deploy.yml).'
      ).toBe(true);
    }
  });

  it('baseline.json is well-formed', () => {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
    expect(baseline.bundle.totalBytes).toBeGreaterThan(0);
    expect(baseline.bundle.fileCount).toBeGreaterThan(0);
    expect(baseline.bundle.tolerance.totalGrowthFraction).toBeGreaterThan(0);
    expect(baseline.bundle.tolerance.totalGrowthFraction).toBeLessThan(1);
    expect(baseline.bundle.tolerance.fileCountDelta).toBeGreaterThan(0);
  });
});
