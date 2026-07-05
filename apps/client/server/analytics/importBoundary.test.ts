// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Architectural guard rail: server/analytics/ is b4m-owned product code that must NOT
// depend on server/overwatch/ (Overwatch-owned code that leaves the repo when Overwatch extracts).
// The migration story - "repoint one secret, zero code change" - only holds while this boundary is
// intact. Shared schema/types from @bike4mind/* are allowed (they're published/extract-safe);
// anything resolving into server/overwatch/ is not.
const ANALYTICS_DIR = dirname(fileURLToPath(import.meta.url));

const IMPORT_SPECIFIER = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function sourceFiles(): string[] {
  return readdirSync(ANALYTICS_DIR).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

function importSpecifiers(contents: string): string[] {
  const specs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = IMPORT_SPECIFIER.exec(contents)) !== null) {
    specs.push(m[1] ?? m[2]);
  }
  return specs;
}

// Forbidden: any specifier that resolves into server/overwatch/. Allowed: @bike4mind/* shared
// packages (e.g. @bike4mind/common's Overwatch* schema/types), which are extract-safe.
function crossesOverwatchBoundary(spec: string): boolean {
  if (spec.startsWith('@bike4mind/')) return false;
  return /overwatch/i.test(spec);
}

describe('server/analytics import boundary', () => {
  it('has source files to check', () => {
    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  it('no file imports from server/overwatch/', () => {
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      const contents = readFileSync(join(ANALYTICS_DIR, file), 'utf8');
      for (const spec of importSpecifiers(contents)) {
        if (crossesOverwatchBoundary(spec)) {
          violations.push(`${file} imports "${spec}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
