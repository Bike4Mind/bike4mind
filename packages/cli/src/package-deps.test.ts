/**
 * Validates that all runtime imports in CLI source files are properly
 * declared as production dependencies (not devDependencies).
 *
 * This catches the class of bug where a package is used at runtime but
 * only declared as a devDependency, causing ERR_MODULE_NOT_FOUND on fresh installs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
// Shared with the build-time bundle guard so the two "is this an installable
// external package" definitions can't drift apart (they used to).
import { getPackageName, isExternalPackage } from './verifyBundleExternals';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(__dirname, '..');
const SRC_DIR = join(CLI_ROOT, 'src');

const pkg = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf-8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const productionDeps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
]);

// Test file patterns to exclude - devDependencies are fine in test code
const TEST_PATTERNS = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];
const TEST_DIRS = new Set(['test-utils', '__tests__']);

function extractRuntimeImports(content: string): string[] {
  const specifiers: string[] = [];

  // Static imports - skip `import type` (type-erased at compile time)
  // Matches: import ..., import * as ..., import X from ..., import '...'
  const staticRe = /^import(?!\s+type[\s{*])[\s\S]*?from\s+['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = staticRe.exec(content)) !== null) {
    specifiers.push(match[1]);
  }

  // Side-effect imports: import 'pkg'
  const sideEffectRe = /^import\s+['"]([^'"]+)['"]/gm;
  while ((match = sideEffectRe.exec(content)) !== null) {
    specifiers.push(match[1]);
  }

  // Dynamic imports: import('pkg')
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicRe.exec(content)) !== null) {
    specifiers.push(match[1]);
  }

  return specifiers;
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!TEST_DIRS.has(entry)) {
        files.push(...collectSourceFiles(full));
      }
    } else if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && !TEST_PATTERNS.some(p => entry.endsWith(p))) {
      files.push(full);
    }
  }
  return files;
}

describe('CLI dependency audit', () => {
  it('all runtime imports are declared as production dependencies', () => {
    const sourceFiles = collectSourceFiles(SRC_DIR);
    const missing = new Map<string, string[]>(); // pkg -> files that import it

    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf-8');
      const specifiers = extractRuntimeImports(content);

      for (const specifier of specifiers) {
        if (!isExternalPackage(specifier)) continue;
        const pkgName = getPackageName(specifier);
        if (!productionDeps.has(pkgName)) {
          const relative = file.replace(CLI_ROOT + '/', '');
          if (!missing.has(pkgName)) missing.set(pkgName, []);
          missing.get(pkgName)!.push(relative);
        }
      }
    }

    if (missing.size > 0) {
      const report = [...missing.entries()]
        .map(([dep, files]) => `  "${dep}" (imported in: ${files.join(', ')})`)
        .join('\n');
      expect.fail(
        `The following packages are imported in runtime code but missing from "dependencies":\n${report}\n\n` +
          `Move them from devDependencies to dependencies in packages/cli/package.json.`
      );
    }
  });
});
