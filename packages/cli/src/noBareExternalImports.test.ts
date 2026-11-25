/**
 * The bundle marks externals side-effect free (tsdown.config.ts), so a bare
 * `import 'pkg'` of an external package is dropped from the build. Fail on one
 * here instead of shipping a binary that silently lacks the side effect.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isExternalPackage } from './verifyBundleExternals';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const BARE_IMPORT = /^\s*import\s+(['"])([^'"]+)\1/gm;
const STYLESHEET = /\.(css|scss|sass|less)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.test\.[mc]?tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('bare side-effect imports of external packages', () => {
  it('none exist in packages/cli/src', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      for (const match of readFileSync(file, 'utf-8').matchAll(BARE_IMPORT)) {
        const specifier = match[2];
        if (isExternalPackage(specifier) && !STYLESHEET.test(specifier)) {
          offenders.push(`${resolve(file).slice(SRC_DIR.length + 1)}: import '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
