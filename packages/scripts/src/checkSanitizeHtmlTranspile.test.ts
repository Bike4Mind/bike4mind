import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Pins `sanitize-html` into apps/client/next.config.mjs's transpilePackages.
 *
 * Without the entry Turbopack externalizes sanitize-html into .next/node_modules under a hashed
 * name where its own dependencies no longer resolve, so every importing route throws at module
 * load and Next serves a 500 before auth middleware runs. Vitest resolves through node rather
 * than Turbopack, so tests importing the real sanitizer pass on the broken build too -- hence a
 * declaration-site pin. Importers come from git grep so a third one is covered without an edit.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONFIG_PATH = path.join(REPO_ROOT, 'apps/client/next.config.mjs');

function sanitizeHtmlImporters(): string[] {
  const stdout = execFileSync('git', ['grep', '-l', "from 'sanitize-html'", '--', 'apps/client'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return stdout.split('\n').filter(Boolean);
}

describe('sanitize-html is bundled, not externalized', () => {
  let transpilePackages: string[];

  beforeAll(async () => {
    const config = await import(CONFIG_PATH);
    transpilePackages = config.default.transpilePackages;
  });

  it('is still imported somewhere in apps/client', () => {
    // Guards the guard: with no importers the assertion below would be vacuously satisfiable by
    // dropping the entry, and the grep pattern silently rotting is the likeliest way to get here.
    expect(sanitizeHtmlImporters().length).toBeGreaterThan(0);
  });

  it('is declared in transpilePackages', () => {
    const importers = sanitizeHtmlImporters().join(', ');
    expect(
      transpilePackages,
      `every apps/client import of sanitize-html 500s at module load without this entry: ${importers}`
    ).toContain('sanitize-html');
  });
});
