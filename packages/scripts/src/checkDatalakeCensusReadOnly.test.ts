import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards the read-only contract of the pre-merge prefix-only-member census: it audits data lake
 * membership across every tenant and MUST never be able to write. Mirrors the source-level guard
 * in checkNoRawS3Client.test.ts - a mechanical check the census cannot regress into a script that
 * mutates a lake or a file while an owner is only expecting a report.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENTRY_PATH = 'packages/scripts/migrate/check-datalake-prefix-only-members.ts';
// The census executes BOTH files. Guarding only the entry point would leave a write added to the
// report module outside the control entirely.
const SCRIPT_PATHS = [ENTRY_PATH, 'packages/scripts/migrate/prefixOnlyMembersReport.ts'];

// `findByIdAnd*`, `insertOne` (a real Model method since Mongoose 8.9) and `bulkSave` are spelled
// out rather than folded into the `findOneAnd*` / `insert` alternatives: none of them share a
// prefix with one, so a looser pattern would still have missed them.
const WRITE_METHOD_PATTERN =
  /\.(updateOne|updateMany|deleteOne|deleteMany|findOneAndUpdate|findOneAndDelete|findOneAndReplace|findByIdAndUpdate|findByIdAndDelete|findByIdAndRemove|insertOne|insertMany|bulkWrite|bulkSave|replaceOne|remove|save|create)\s*\(/;
// Collection/DDL verbs, separate from the document-write list above. Generic hardening: a Mongoose
// model has always exposed `.collection` (native Collection) and `.db` (Connection), so this reach
// is not new - the document-write list simply never named the destructive collection-level verbs.
const DDL_METHOD_PATTERN = /\.(drop|dropDatabase|dropIndexes?|createCollection|createIndexe?s?|syncIndexes)\s*\(/;
// An aggregation stage is the most plausible way a counting script grows a write path, and it
// looks nothing like a write method.
const AGGREGATE_WRITE_PATTERN = /\$out\b|\$merge\b/;

describe('the prefix-only-member census stays read-only', () => {
  const sources = new Map(SCRIPT_PATHS.map(p => [p, readFileSync(path.join(REPO_ROOT, p), 'utf8')]));

  it.each(SCRIPT_PATHS)('calls no Mongoose write method: %s', p => {
    expect(WRITE_METHOD_PATTERN.test(sources.get(p)!)).toBe(false);
  });

  it.each(SCRIPT_PATHS)('has no write-stage aggregation: %s', p => {
    expect(AGGREGATE_WRITE_PATTERN.test(sources.get(p)!)).toBe(false);
  });

  it.each(SCRIPT_PATHS)('calls no collection-level DDL verb: %s', p => {
    expect(DDL_METHOD_PATTERN.test(sources.get(p)!)).toBe(false);
  });

  it('imports only raw models, never a repository', () => {
    const source = sources.get(ENTRY_PATH)!;
    expect(source).not.toMatch(/fabFileRepository|dataLakeRepository/);
    expect(source).toMatch(/import\s*\{[^}]*\bFabFile\b[^}]*\}\s*from\s*'@bike4mind\/database'/);
    expect(source).toMatch(/import\s*\{[^}]*\bDataLakeModel\b[^}]*\}\s*from\s*'@bike4mind\/database'/);
  });

  // The census DOES write one file - the JSON artifact - and that is disclosed in its docblock.
  // What must never come back is resolving it against the working directory: under the documented
  // `pnpm --filter scripts` invocation that is packages/scripts, inside this public repo's tree,
  // where the artifact's cross-tenant identity data is one `git add -A` from permanent.
  //
  // Comments are stripped before these run. A comment explaining why the working directory is
  // avoided would otherwise trip the negative grep - which already happened once during review.
  const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('resolves the artifact outside the repo tree', () => {
    const code = stripComments(sources.get(ENTRY_PATH)!);
    // Every spelling that lands in the repo tree, not just one. `resolve('.'` and the module-dir
    // global are as repo-local as the working directory and were previously unguarded.
    expect(code).not.toMatch(/process\.cwd\(\)|__dirname|resolve\(\s*['"`]\.\.?['"`]/);
    expect(code).toMatch(/const\s+outDir\s*=[^;]*os\.tmpdir\(\)/);
  });

  // Tied to the CALL, not grepped file-wide: with whole-file `toMatch`, a SECOND unprotected
  // writeFileSync elsewhere kept every assertion green (verified by mutation during review),
  // because the first write still supplied both literals.
  it('gives every file write owner-only permissions', () => {
    const code = stripComments(sources.get(ENTRY_PATH)!);
    const calls = [...code.matchAll(/writeFileSync\s*\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(code.slice(call.index, call.index + 600)).toMatch(/mode:\s*0o600/);
    }
  });
});
