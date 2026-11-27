import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

/**
 * A recursive hashFiles glob in ci.yml is evaluated after `pnpm install` in most jobs (and again by
 * every actions/cache Post step), so it walks node_modules: ~14s per evaluation, and the lockfiles
 * that dependencies ship make the key differ between restore and save, so it never hits.
 */
describe('ci.yml cache keys', () => {
  it('never hashes a recursive glob', () => {
    const recursive = workflow.split('\n').filter(line => /hashFiles\([^)]*\*\*/.test(line));
    expect(recursive).toEqual([]);
  });

  it('keys the dependency caches on the root lockfile', () => {
    const keys = workflow.split('\n').filter(line => /key: .*-(pnpm|mongodb-binaries)-\$\{\{/.test(line));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toContain("hashFiles('pnpm-lock.yaml')");
    }
  });
});
