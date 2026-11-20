import { readdirSync } from 'fs';
import { describe, it, expect, vi } from 'vitest';
import type { MigrationFile } from './index';

// At least one real core migration imports ../utils/config, which evaluates SST Resource
// bindings at module load time and throws outside an SST-linked process (same constraint
// migrationManager.test.ts hits and mocks around). Not the thing under test here.
vi.mock('../../utils/config', () => ({ Config: {} }));

/**
 * Real (unmocked) fork-path assertion for the overlay-migration seam.
 *
 * migrationManager.test.ts proves the applied-set SELECTION LOGIC is correct for any
 * well-formed AvailableMigrations array. This file proves the array construction itself is
 * sound in the actual repo state: importing the real `./index` (which concatenates the ~55
 * real core migrations with the real, gitignored, codegen-produced `./premium.generated`)
 * does not throw the duplicate-id guard and yields a coherent array - including today's
 * open-core/no-overlay-migrationsExport form, where premiumMigrations is empty. Together
 * these two files prove the whole chain (core + premium concat -> selection) without
 * executing any individual migration's real up()/down() side effects.
 */
import { AvailableMigrations } from './index';
import { premiumMigrations } from './premium.generated';

describe('AvailableMigrations (real, unmocked)', () => {
  it('imports without throwing the duplicate-id guard', () => {
    expect(AvailableMigrations.length).toBeGreaterThan(0);
  });

  it('has no duplicate ids across core + premium migrations', () => {
    const ids = AvailableMigrations.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes every premium-contributed migration (present or empty form)', () => {
    for (const migration of premiumMigrations) {
      expect(AvailableMigrations).toContain(migration);
    }
  });

  it('every migration exposes the MigrationFile contract', () => {
    for (const migration of AvailableMigrations) {
      expect(typeof migration.id).toBe('number');
      expect(typeof migration.name).toBe('string');
      expect(typeof migration.up).toBe('function');
      expect(typeof migration.down).toBe('function');
    }
  });
});

/**
 * Directory-completeness guard: a migration file can exist on disk and still never run if the
 * generated `coreMigrations` registry (core.generated.ts) misses it or is stale. The tests above
 * only inspect the built AvailableMigrations array, so an unregistered file is invisible to them.
 * This scans the directory itself and cross-checks every migration file against the array.
 */
describe('every migration file on disk is registered', () => {
  // Core ids are 13-14 digit timestamps followed by '-' or '_' (both separators appear in the
  // directory, e.g. `2024052201905_demo_to_paid.ts` vs `20250704005300-add-filename-lowercase.ts`).
  // Must match CORE_MIGRATION_FILE_RE in apps/client/scripts/generate-premium-glue.mjs.
  const MIGRATION_FILE = /^\d{11,14}[-_].+\.ts$/;

  const migrationFiles = readdirSync(new URL('.', import.meta.url)).filter(
    f => MIGRATION_FILE.test(f) && !f.endsWith('.test.ts')
  );

  it('found at least one migration file to check (sanity check the scan itself)', () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  it.each(migrationFiles)('%s is present in AvailableMigrations', async filename => {
    const modulePath = `./${filename.replace(/\.ts$/, '')}`;
    const { default: migration } = (await import(modulePath)) as { default: MigrationFile };
    expect(AvailableMigrations.map(m => m.id)).toContain(migration.id);
  });
});

/**
 * Core id uniqueness straight from the files on disk, independent of the generated registry, so
 * two PRs that each passed CI alone but collide once both land fail main's CI on push rather than
 * the DatabaseMigrator at deploy. The filename prefix is what scripts/check-migration-ids.mjs
 * validates, so the id inside each file must match it.
 */
describe('core migration ids are unique', () => {
  const MIGRATION_FILE = /^(\d+)[-_].+\.ts$/;
  const migrationFiles = readdirSync(new URL('.', import.meta.url)).filter(
    f => MIGRATION_FILE.test(f) && !f.endsWith('.test.ts')
  );
  const prefixOf = (filename: string) => MIGRATION_FILE.exec(filename)![1];

  it('no two migration files share an id prefix', () => {
    const byPrefix = Map.groupBy(migrationFiles, prefixOf);
    const collisions = [...byPrefix.values()].filter(files => files.length > 1);
    expect(collisions).toEqual([]);
  });

  it.each(migrationFiles)('%s declares the id in its filename', async filename => {
    const { default: migration } = (await import(`./${filename.replace(/\.ts$/, '')}`)) as {
      default: MigrationFile;
    };
    expect(String(migration.id)).toBe(prefixOf(filename));
  });
});
