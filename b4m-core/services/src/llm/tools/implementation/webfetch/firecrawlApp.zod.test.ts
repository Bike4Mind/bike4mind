import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { FirecrawlApp } from './firecrawlApp';

// firecrawl-js 1.x (and the zod-to-json-schema it uses) declare zod ^3, which has no release
// patched for GHSA-mrhx-c7xc-m3w5. The `zod@<4.0.0` override in pnpm-workspace.yaml moves them
// onto the patched zod 4; these tests fail if that override is dropped or stops applying.
const PATCHED_ZOD = [4, 6, 6] as const;

type PackageJson = { name: string; version: string };

function readManifest(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
}

/** Directory of `name` as Node resolves it from `fromDir` (walks up from the entry file). */
function resolvePackageDir(fromDir: string, name: string): string {
  let dir = dirname(createRequire(join(fromDir, 'noop.js')).resolve(name));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json')) && readManifest(dir).name === name) return dir;
    dir = dirname(dir);
  }
  throw new Error(`no package.json for ${name} above its entry (resolved from ${fromDir})`);
}

function isPatchedZod(version: string): boolean {
  const parts = version.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < PATCHED_ZOD.length; i++) {
    if (parts[i] !== PATCHED_ZOD[i]) return parts[i] > PATCHED_ZOD[i];
  }
  return true;
}

describe('firecrawl-js resolves a zod patched for GHSA-mrhx-c7xc-m3w5', () => {
  const firecrawlDir = resolvePackageDir(dirname(fileURLToPath(import.meta.url)), '@mendable/firecrawl-js');

  it('firecrawl-js resolves zod >= 4.6.6', () => {
    const { version } = readManifest(resolvePackageDir(firecrawlDir, 'zod'));
    expect(isPatchedZod(version), `firecrawl-js resolves zod ${version}`).toBe(true);
  });

  it('the zod-to-json-schema firecrawl-js uses resolves the same patched zod', () => {
    const converterDir = resolvePackageDir(firecrawlDir, 'zod-to-json-schema');
    const { version } = readManifest(resolvePackageDir(converterDir, 'zod'));
    expect(isPatchedZod(version), `zod-to-json-schema resolves zod ${version}`).toBe(true);
    expect(resolvePackageDir(converterDir, 'zod')).toBe(resolvePackageDir(firecrawlDir, 'zod'));
  });

  it('firecrawl-js still loads and constructs on zod 4', () => {
    expect(() => new FirecrawlApp({ apiKey: 'fc-test', apiUrl: 'https://firecrawl.invalid' })).not.toThrow();
  });
});
