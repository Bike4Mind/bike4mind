import { describe, it, expect, vi } from 'vitest';

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
