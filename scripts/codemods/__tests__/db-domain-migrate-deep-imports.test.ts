import { describe, it, expect } from 'vitest';
import { Project, QuoteKind } from 'ts-morph';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { migrateSourceFile, resolveNewPath, SKIP, type DomainMap } from '../db-domain-migrate-deep-imports';

const FIXTURES = path.join(import.meta.dirname, 'fixtures/db-domain');

function loadFixture(name: string, dir: 'input' | 'expected'): string {
  return readFileSync(path.join(FIXTURES, dir, `${name}.ts`), 'utf-8');
}

// Synthetic domain map — test isolation; no real file system reads
const FIXTURE_DOMAIN_MAP: DomainMap = new Map([
  ['SessionModel', '@bike4mind/database/auth'],
  ['ConnectionModel', '@bike4mind/database/social'],
  ['QuestModel', '@bike4mind/database/content'],
  ['UserModel', '@bike4mind/database/auth'],
  ['AgentModel', '@bike4mind/database/ai'],
  ['BaseModel', '@bike4mind/database'],
  ['testModelStats', SKIP],
]);

function runMigration(source: string): string {
  const project = new Project({
    useInMemoryFileSystem: true,
    manipulationSettings: { quoteKind: QuoteKind.Single },
  });
  const sf = project.createSourceFile('test.ts', source);
  migrateSourceFile(sf, FIXTURE_DOMAIN_MAP);
  return sf.getFullText();
}

describe('db-domain-migrate-deep-imports', () => {
  it('pure-rewrite-named: rewrites named imports to domain sub-path', () => {
    const input = loadFixture('pure-rewrite-named', 'input');
    const expected = loadFixture('pure-rewrite-named', 'expected');
    expect(runMigration(input)).toBe(expected);
  });

  it('pure-rewrite-default: rewrites default import to domain sub-path', () => {
    const input = loadFixture('pure-rewrite-default', 'input');
    const expected = loadFixture('pure-rewrite-default', 'expected');
    expect(runMigration(input)).toBe(expected);
  });

  it('mixed-default-named: rewrites mixed default+named import to domain sub-path', () => {
    const input = loadFixture('mixed-default-named', 'input');
    const expected = loadFixture('mixed-default-named', 'expected');
    expect(runMigration(input)).toBe(expected);
  });

  it('type-only-statement: preserves statement-level type-only import', () => {
    const input = loadFixture('type-only-statement', 'input');
    const expected = loadFixture('type-only-statement', 'expected');
    expect(runMigration(input)).toBe(expected);
  });

  it('type-only-inline: preserves inline type modifier on named imports', () => {
    const input = loadFixture('type-only-inline', 'input');
    const expected = loadFixture('type-only-inline', 'expected');
    expect(runMigration(input)).toBe(expected);
  });

  it('export-declaration: rewrites export { X } from deep path', () => {
    const input = loadFixture('export-declaration', 'input');
    const expected = loadFixture('export-declaration', 'expected');
    expect(runMigration(input)).toBe(expected);
  });

  it('barrel-rewrite: rewrites @bike4mind/database/src/models barrel to root', () => {
    const input = loadFixture('barrel-rewrite', 'input');
    const expected = loadFixture('barrel-rewrite', 'expected');
    expect(runMigration(input)).toBe(expected);
  });

  it('documentdb-compat-to-root: rewrites documentdb-compat deep import to root', () => {
    const input = loadFixture('documentdb-compat-to-root', 'input');
    const expected = loadFixture('documentdb-compat-to-root', 'expected');
    expect(runMigration(input)).toBe(expected);
  });

  it('base-model-to-root: rewrites BaseModel import to root barrel (preserves default identifier)', () => {
    const input = loadFixture('base-model-to-root', 'input');
    const expected = loadFixture('base-model-to-root', 'expected');
    expect(runMigration(input)).toBe(expected);
  });

  it('bare-src-rewrite: rewrites @bike4mind/database/src to root', () => {
    const input = loadFixture('bare-src-rewrite', 'input');
    const expected = loadFixture('bare-src-rewrite', 'expected');
    expect(runMigration(input)).toBe(expected);
  });

  it('trivia-preservation: comments above import are preserved', () => {
    const input = loadFixture('trivia-preservation', 'input');
    const expected = loadFixture('trivia-preservation', 'expected');
    expect(runMigration(input)).toBe(expected);
  });

  it('no-op: already-migrated file is unchanged', () => {
    const input = loadFixture('no-op', 'input');
    const expected = loadFixture('no-op', 'expected');
    const result = runMigration(input);
    expect(result).toBe(expected);
    expect(result).toBe(input); // input and expected are identical for a no-op
  });

  it('aliased-import: rewrites aliased named import to domain sub-path', () => {
    const input = loadFixture('aliased-import', 'input');
    const expected = loadFixture('aliased-import', 'expected');
    expect(runMigration(input)).toBe(expected);
  });

  it('resolveNewPath: throws on unknown model name', () => {
    expect(() => resolveNewPath('@bike4mind/database/src/models/UnknownModel', FIXTURE_DOMAIN_MAP)).toThrow(
      'Unknown model "UnknownModel"'
    );
  });

  it('resolveNewPath: returns null for non-deep imports', () => {
    expect(resolveNewPath('@bike4mind/database', FIXTURE_DOMAIN_MAP)).toBeNull();
    expect(resolveNewPath('@bike4mind/database/auth', FIXTURE_DOMAIN_MAP)).toBeNull();
    expect(resolveNewPath('@bike4mind/observability', FIXTURE_DOMAIN_MAP)).toBeNull();
  });

  it('resolveNewPath: __skip__ model returns null (no rewrite)', () => {
    expect(resolveNewPath('@bike4mind/database/src/models/testModelStats', FIXTURE_DOMAIN_MAP)).toBeNull();
  });
});
