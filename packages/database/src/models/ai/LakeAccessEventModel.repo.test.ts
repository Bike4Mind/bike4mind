import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

describe('lake access audit repository writes', () => {
  it('no other source file writes to LakeAccessEventModel/LakeAccessQueryTextModel outside their own repository methods', () => {
    const repoRoot = path.resolve(__dirname, '../../../../..');
    const relFromRoot = (p: string) => path.relative(repoRoot, p).split(path.sep).join('/');
    const allowedFiles = new Set([
      relFromRoot(path.resolve(__dirname, 'LakeAccessEventModel.test.ts')),
      relFromRoot(path.resolve(__dirname, 'LakeAccessEventModel.ts')),
      relFromRoot(path.resolve(__dirname, 'LakeAccessQueryTextModel.ts')),
      // Index migration tests need raw collection access to assert and reset indexes.
      'packages/scripts/migrate/migrations/20260820000000_ensure-lakeaccessevent-questid-index.integration.test.ts',
      'packages/scripts/migrate/migrations/20260827000000_ensure-lake-audit-tiebreak-indexes.integration.test.ts',
    ]);
    // Covers direct model writes and collection access, but cannot detect aliased model imports.
    const pattern =
      '(LakeAccessEventModel|LakeAccessQueryTextModel)\\s*\\.\\s*(updateOne|updateMany|findOneAndUpdate|bulkWrite|replaceOne|collection)\\s*[.(]';
    let output = '';
    try {
      output = execFileSync('git', ['grep', '-lP', pattern, '--', '*.ts', '*.tsx'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      });
    } catch (err) {
      if ((err as { status?: number }).status !== 1) throw err;
    }
    expect(
      output
        .split('\n')
        .filter(Boolean)
        .filter(file => !allowedFiles.has(file))
    ).toEqual([]);
  });
});
