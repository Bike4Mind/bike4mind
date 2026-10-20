import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '../../../..');
const ROOTS = ['apps/client/server', 'apps/client/pages', 'apps/workers/src'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('image moderation incident wiring', () => {
  // The bare repository records silently; only the imageModerationIncidents wrapper alerts reviewers.
  it('records every incident through the reviewer-alerting store', () => {
    const offenders = ROOTS.flatMap(root => sourceFiles(join(REPO_ROOT, root)))
      .filter(file => /incidents\s*:\s*imageModerationIncidentRepository\b/i.test(readFileSync(file, 'utf8')))
      .map(file => relative(REPO_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
