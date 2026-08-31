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
const SCRIPT_PATH = 'packages/scripts/migrate/check-datalake-prefix-only-members.ts';

const WRITE_METHOD_PATTERN =
  /\.(updateOne|updateMany|deleteOne|deleteMany|findOneAndUpdate|findOneAndDelete|findOneAndReplace|insertMany|bulkWrite|replaceOne|save|create)\s*\(/;

describe('the prefix-only-member census stays read-only', () => {
  const source = readFileSync(path.join(REPO_ROOT, SCRIPT_PATH), 'utf8');

  it('calls no Mongoose write method', () => {
    expect(WRITE_METHOD_PATTERN.test(source)).toBe(false);
  });

  it('imports only raw models, never a repository', () => {
    expect(source).not.toMatch(/fabFileRepository|dataLakeRepository/);
    expect(source).toMatch(/import\s*\{[^}]*\bFabFile\b[^}]*\}\s*from\s*'@bike4mind\/database'/);
    expect(source).toMatch(/import\s*\{[^}]*\bDataLakeModel\b[^}]*\}\s*from\s*'@bike4mind\/database'/);
  });
});
