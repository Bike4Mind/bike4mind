import fs from 'fs';

/**
 * Formats a migration id as YYYYMMDDHHMMSS in UTC. Must stay UTC: scripts/check-migration-ids.mjs
 * reads ids as UTC and rejects one more than an hour in the future, which a local-time id from a
 * timezone ahead of UTC would be.
 */
export function formatMigrationId(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/\D/g, '');
}

/** Returns the migration file in `migrationsDir` that already uses `id`, if any. */
export function findMigrationWithId(migrationsDir: string, id: string): string | undefined {
  return fs.readdirSync(migrationsDir).find(f => /^\d+[-_]/.test(f) && f.split(/[-_]/, 1)[0] === id);
}
