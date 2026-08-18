import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Drift guard for the premium migrations codegen glue.
 *
 * packages/scripts/migrate/migrations/premium.generated.ts is emitted by
 * scripts/generate-premium-glue.mjs (generateMigrations) in two forms:
 *   overlay declares b4mContributions.migrationsExport -> spreads its migrations array
 *   no overlay declares it (open-core / not-yet-adopted) -> exports an empty array
 *
 * These tests read the existing generated file (mirrors premiumInfraGlue.test.ts's trust
 * model: turbo's codegen task - a dependency of typecheck/build - and pnpm postinstall both
 * invoke the script before any test can run) and verify it matches whichever overlays
 * currently declare migrationsExport, catching: a present overlay silently producing the
 * empty form (e.g. a typo'd contribution key) and vice versa.
 *
 * Deliberately does NOT re-invoke generate-premium-glue.mjs itself: that script's
 * generateApiStubs wipes and rebuilds the whole premium-namespaced pages/api tree, which
 * raced with premiumToolsWiring.test.ts's directory scan of that same tree when both ran
 * concurrently (no ordering edge between sibling test files) - a real, if low-probability,
 * flake this file used to introduce. Reading the already-generated file avoids the race
 * entirely.
 */

const REPO_ROOT = join(__dirname, '../../..');
const PREMIUM_DIR = join(REPO_ROOT, 'packages/premium');
const GENERATED_FILE = join(REPO_ROOT, 'packages/scripts/migrate/migrations/premium.generated.ts');

function discoverMigrationsExportContributors(): { name: string; migrationsExport: string }[] {
  if (!existsSync(PREMIUM_DIR)) return [];
  const contributors: { name: string; migrationsExport: string }[] = [];
  for (const entry of readdirSync(PREMIUM_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(PREMIUM_DIR, entry.name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const migrationsExport = pkg.b4mContributions?.migrationsExport;
      if (migrationsExport) contributors.push({ name: pkg.name, migrationsExport });
    } catch {
      // malformed package.json - skip, mirrors generate-premium-glue.mjs's own handling
    }
  }
  return contributors;
}

describe('premium migrations codegen glue', () => {
  const contributors = discoverMigrationsExportContributors();

  it('generated file exists', () => {
    expect(existsSync(GENERATED_FILE), 'premium.generated.ts not found - run pnpm codegen').toBe(true);
  });

  it('is in the empty form when no overlay declares migrationsExport', () => {
    if (contributors.length > 0) return; // caught by the present-form test below
    const content = readFileSync(GENERATED_FILE, 'utf8');
    expect(content).toContain('export const premiumMigrations: MigrationFile[] = [];');
    expect(content).not.toContain('import {');
  });

  it.each(contributors)('$name: generated glue imports its migrationsExport specifier', ({ migrationsExport }) => {
    const content = readFileSync(GENERATED_FILE, 'utf8');
    expect(content).toContain(`from '${migrationsExport}'`);
    expect(content).not.toBe('export const premiumMigrations: MigrationFile[] = [];');
  });

  it('generated file always exports the MigrationFile-typed premiumMigrations array', () => {
    const content = readFileSync(GENERATED_FILE, 'utf8');
    expect(content).toContain(`import type { MigrationFile } from '@bike4mind/database';`);
    expect(content).toContain('export const premiumMigrations: MigrationFile[]');
  });
});
