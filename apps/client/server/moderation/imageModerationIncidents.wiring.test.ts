import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '../../../..');
const ROOTS = ['apps', 'b4m-core', 'packages', 'selfhost'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.next', '.sst', '.turbo', 'build', 'coverage']);

// The repository's own module, the alerting wrapper, and read-only admin routes (they list and
// update incidents, never record one).
const ALLOWED = new Set([
  'packages/database/src/models/content/ImageModerationIncidentModel.ts',
  'apps/client/server/moderation/imageModerationIncidents.ts',
  'apps/client/pages/api/admin/moderation-incidents/index.ts',
  'apps/client/pages/api/admin/moderation-incidents/[id]/verdict.ts',
  'apps/client/pages/api/admin/users/[userId]/compliance.ts',
]);

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(path);
    return /\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('image moderation incident wiring', () => {
  // The bare repository records silently; only the imageModerationIncidents wrapper alerts reviewers.
  it('records every incident through the reviewer-alerting store', () => {
    const offenders = ROOTS.flatMap(root => sourceFiles(join(REPO_ROOT, root)))
      .map(file => relative(REPO_ROOT, file))
      .filter(file => !ALLOWED.has(file))
      .filter(file => /\bimageModerationIncidentRepository\b/.test(readFileSync(join(REPO_ROOT, file), 'utf8')));

    expect(offenders).toEqual([]);
  });
});
