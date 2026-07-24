import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Drift guard for the premium migrations codegen glue.
 *
 * packages/scripts/migrate/migrations/premium.generated.ts is emitted by
 * scripts/generate-premium-glue.mjs (generateMigrations) in two forms:
 *   overlay declares b4mContributions.migrationsExport -> spreads its migrations array
 *   no overlay declares it (open-core / not-yet-adopted) -> exports an empty array
 *
 * These tests re-run codegen (so the file reflects the CURRENT repo state rather than a
 * stale prior run) and verify the generated file matches whichever overlays currently
 * declare migrationsExport, catching: a present overlay silently producing the empty form
 * (e.g. a typo'd contribution key) and vice versa.
 */

const REPO_ROOT = join(__dirname, '../../..');
const CLIENT_ROOT = join(REPO_ROOT, 'apps/client');
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

  beforeAll(() => {
    // Re-run codegen so the generated file reflects THIS test run's repo state, not
    // whatever last wrote it (a stale postinstall run, a different branch, etc.).
    execFileSync('node', ['scripts/generate-premium-glue.mjs'], { cwd: CLIENT_ROOT, stdio: 'pipe' });
  });

  it('generated file exists after codegen', () => {
    expect(existsSync(GENERATED_FILE), 'premium.generated.ts not found after running codegen').toBe(true);
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
