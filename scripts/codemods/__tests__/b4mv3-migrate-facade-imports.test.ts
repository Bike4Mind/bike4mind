import { describe, it, expect } from 'vitest';
import { Project, QuoteKind } from 'ts-morph';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { migrateSourceFile, SLICE_CONFIGS } from '../b4mv3-migrate-facade-imports';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

function loadFixture(name: string, dir: 'input' | 'expected'): string {
  return readFileSync(path.join(FIXTURES, dir, `${name}.ts`), 'utf-8');
}

function runMigration(source: string, slice: 'observability' | 'fab-pipeline' | 'llm-adapters' | 'auth'): string {
  const project = new Project({
    useInMemoryFileSystem: true,
    manipulationSettings: { quoteKind: QuoteKind.Single },
  });
  const sf = project.createSourceFile('test.ts', source);
  migrateSourceFile(sf, SLICE_CONFIGS[slice]);
  return sf.getFullText();
}

describe('b4mv3-migrate-facade-imports', () => {
  it('pure-rewrite: rewrites all symbols to target package', () => {
    const input = loadFixture('pure-rewrite', 'input');
    const expected = loadFixture('pure-rewrite', 'expected');
    expect(runMigration(input, 'observability')).toBe(expected);
  });

  it('mixed-import-split: keeps non-deprecated in original, adds new import', () => {
    const input = loadFixture('mixed-import-split', 'input');
    const expected = loadFixture('mixed-import-split', 'expected');
    expect(runMigration(input, 'observability')).toBe(expected);
  });

  it('export-declaration: rewrites export { X } from facade', () => {
    const input = loadFixture('export-declaration', 'input');
    const expected = loadFixture('export-declaration', 'expected');
    expect(runMigration(input, 'observability')).toBe(expected);
  });

  it('import-type-preservation: preserves statement-level and inline type modifiers', () => {
    const input = loadFixture('import-type-preservation', 'input');
    const expected = loadFixture('import-type-preservation', 'expected');
    expect(runMigration(input, 'observability')).toBe(expected);
  });

  it('renamed-import: preserves aliases', () => {
    const input = loadFixture('renamed-import', 'input');
    const expected = loadFixture('renamed-import', 'expected');
    expect(runMigration(input, 'observability')).toBe(expected);
  });

  it('sub-path-rewrite: rewrites @bike4mind/utils/llm/backend path', () => {
    const input = loadFixture('sub-path-rewrite', 'input');
    const expected = loadFixture('sub-path-rewrite', 'expected');
    expect(runMigration(input, 'llm-adapters')).toBe(expected);
  });

  it('trivia-preservation: comment above import is preserved', () => {
    const input = loadFixture('trivia-preservation', 'input');
    const expected = loadFixture('trivia-preservation', 'expected');
    expect(runMigration(input, 'observability')).toBe(expected);
  });

  it('same-symbol-both-facades: observability slice only touches utils Logger, leaves services alone', () => {
    const input = loadFixture('same-symbol-both-facades', 'input');
    const expected = loadFixture('same-symbol-both-facades', 'expected');
    expect(runMigration(input, 'observability')).toBe(expected);
  });

  it('no-op: already-migrated file is unchanged', () => {
    const input = loadFixture('no-op', 'input');
    const expected = loadFixture('no-op', 'expected');
    const result = runMigration(input, 'observability');
    expect(result).toBe(expected);
    // input and expected are identical for a no-op
    expect(result).toBe(input);
  });
});
