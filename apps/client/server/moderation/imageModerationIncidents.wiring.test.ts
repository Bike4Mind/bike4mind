import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '../../../..');
const ROOTS = ['apps', 'b4m-core', 'packages', 'selfhost'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.next', '.sst', '.turbo', 'build', 'coverage']);

// The repository's own module, the alerting wrapper, read-only admin routes (they list and
// update incidents, never record one), and the review sweep (it re-alerts, never records).
const ALLOWED = new Set([
  'packages/database/src/models/content/ImageModerationIncidentModel.ts',
  'apps/client/server/moderation/imageModerationIncidents.ts',
  'apps/client/pages/api/admin/moderation-incidents/index.ts',
  'apps/client/pages/api/admin/moderation-incidents/[id]/verdict.ts',
  'apps/client/pages/api/admin/moderation-incidents/[id]/view.ts',
  'apps/client/pages/api/admin/users/[userId]/compliance.ts',
  'apps/workers/src/cron/imageModerationReviewSweep.ts',
]);

// Signing an incident image hands out a link to a blocked upload; only the view route may do it,
// because it is the one that checks a full admin, step-up and audits the view first.
const IMAGE_LINK_MODULE = 'apps/client/server/moderation/incidentImageLink.ts';
const IMAGE_LINK_CALLER = 'apps/client/pages/api/admin/moderation-incidents/[id]/view.ts';

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(path);
    return /\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('image moderation incident wiring', () => {
  // A wrong REPO_ROOT would make every root look empty, and the ban below would pass while
  // scanning nothing.
  it('scans the repository sources and can still see every allowed file', () => {
    const scanned = ROOTS.flatMap(root => sourceFiles(join(REPO_ROOT, root)));

    expect(scanned.length).toBeGreaterThan(4_000);
    for (const allowed of [...ALLOWED, IMAGE_LINK_MODULE, IMAGE_LINK_CALLER]) {
      expect(existsSync(join(REPO_ROOT, allowed))).toBe(true);
    }
  });

  // The bare repository records silently; only the imageModerationIncidents wrapper alerts reviewers.
  it('records every incident through the reviewer-alerting store', () => {
    const offenders = ROOTS.flatMap(root => sourceFiles(join(REPO_ROOT, root)))
      .map(file => relative(REPO_ROOT, file))
      .filter(file => !ALLOWED.has(file))
      .filter(file => /\bimageModerationIncidentRepository\b/.test(readFileSync(join(REPO_ROOT, file), 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('signs incident images from the audited view route only', () => {
    const importers = ROOTS.flatMap(root => sourceFiles(join(REPO_ROOT, root)))
      .map(file => relative(REPO_ROOT, file))
      .filter(file => file !== IMAGE_LINK_MODULE)
      .filter(file => /moderation\/incidentImageLink\b/.test(readFileSync(join(REPO_ROOT, file), 'utf8')));

    expect(importers).toEqual([IMAGE_LINK_CALLER]);
  });
});
