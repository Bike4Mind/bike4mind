import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Drift guard for the premium infra codegen glue.
 *
 * sst.config.ts imports `contributeInfra` from generated glue files under
 * infra/premium-generated/. The glue files are emitted by
 * scripts/generate-premium-glue.mjs in two forms:
 *   overlay PRESENT -> re-exports contributeInfra from the overlay source
 *   overlay ABSENT  -> exports a no-op stub
 *
 * These tests verify that every dir imported by sst.config.ts has a generated
 * file in the correct form, catching: regex drift in getExpectedInfraOverlayDirs,
 * missing codegen runs, and present/absent branch swaps.
 *
 * The generated files exist because turbo codegen (dependsOn of typecheck/build)
 * and pnpm postinstall both invoke the script before any test can run.
 */

const REPO_ROOT = join(__dirname, '../../..');
const SST_CONFIG_PATH = join(REPO_ROOT, 'sst.config.ts');
const INFRA_GENERATED_DIR = join(REPO_ROOT, 'infra/premium-generated');
const PREMIUM_DIR = join(REPO_ROOT, 'packages/premium');

// Mirrors getExpectedInfraOverlayDirs() in generate-premium-glue.mjs.
// Kept separate so regex drift in the script makes THIS test fail, surfacing
// the divergence - if we just imported the script, a bug in the regex would
// silently pass both.
function parseExpectedDirsFromSstConfig(): string[] {
  if (!existsSync(SST_CONFIG_PATH)) return [];
  const content = readFileSync(SST_CONFIG_PATH, 'utf8');
  const matches = [...content.matchAll(/infra\/premium-generated\/([a-z0-9-]+)-infra\.generated/g)];
  return [...new Set(matches.map(m => m[1]))];
}

describe('premium infra codegen glue', () => {
  const expectedDirs = parseExpectedDirsFromSstConfig();

  it('sst.config.ts references at least one infra overlay (sanity check — if zero, the scan itself broke)', () => {
    expect(expectedDirs.length).toBeGreaterThanOrEqual(1);
  });

  it.each(expectedDirs)('%s: generated glue file exists', dir => {
    const glueFile = join(INFRA_GENERATED_DIR, `${dir}-infra.generated.ts`);
    expect(existsSync(glueFile), `infra/premium-generated/${dir}-infra.generated.ts not found — run pnpm codegen`).toBe(
      true
    );
  });

  it.each(expectedDirs)('%s: generated glue file exports contributeInfra', dir => {
    const glueFile = join(INFRA_GENERATED_DIR, `${dir}-infra.generated.ts`);
    if (!existsSync(glueFile)) return; // caught by prior test
    const content = readFileSync(glueFile, 'utf8');
    expect(content).toContain('contributeInfra');
  });

  it.each(expectedDirs)('%s: generated glue file is in the correct form for overlay presence', dir => {
    const glueFile = join(INFRA_GENERATED_DIR, `${dir}-infra.generated.ts`);
    if (!existsSync(glueFile)) return; // caught by prior test
    const content = readFileSync(glueFile, 'utf8');
    const overlayPresent = existsSync(join(PREMIUM_DIR, dir, 'src', 'infra.ts'));

    if (overlayPresent) {
      // Re-export form: must point at the overlay source via relative import.
      expect(content).toContain(`from '../../packages/premium/${dir}/src/infra'`);
    } else {
      // No-op form: must declare a local function (not re-export).
      expect(content).toContain('export function contributeInfra');
    }
  });
});
