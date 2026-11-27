/**
 * The bundle marks externals side-effect free (tsdown.config.ts), so a bare
 * `import 'pkg'` of an external package is dropped from the build. Fail on one
 * here (cli and the inlined b4m-core sources) instead of shipping a binary
 * that silently lacks the side effect.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { relative, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { isExternalPackage } from './verifyBundleExternals';

const CLI_SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(CLI_SRC_DIR, '../../..');
const CORE_DIR = join(REPO_ROOT, 'b4m-core');
const SCAN_ROOTS = [
  CLI_SRC_DIR,
  ...readdirSync(CORE_DIR)
    .map(name => join(CORE_DIR, name, 'src'))
    .filter(dir => existsSync(dir)),
];
const BARE_IMPORT = /^\s*import\s+(['"])([^'"]+)\1/gm;
const STYLESHEET = /\.(css|scss|sass|less)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' ? [] : sourceFiles(path);
    return /\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.test\.[mc]?tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('bare side-effect imports of external packages', () => {
  it('none exist in packages/cli/src or b4m-core/*/src', () => {
    const offenders: string[] = [];
    for (const file of SCAN_ROOTS.flatMap(sourceFiles)) {
      for (const match of readFileSync(file, 'utf-8').matchAll(BARE_IMPORT)) {
        const specifier = match[2];
        if (isExternalPackage(specifier) && !STYLESHEET.test(specifier)) {
          offenders.push(`${relative(REPO_ROOT, file)}: import '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
