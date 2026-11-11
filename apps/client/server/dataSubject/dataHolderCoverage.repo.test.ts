import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_HOLDER_REGISTRY } from './registry';

// Split from dataHolderCoverage.test.ts: this case greps every tracked .ts file, so it runs in the
// uncached `test:repo` lane rather than the unit lane (see vitest.config.mts).
describe('data holder registry: beforeErasure hooks', () => {
  it.each(
    Object.entries(DATA_HOLDER_REGISTRY).flatMap(([name, holder]) =>
      holder.kind === 'holder' ? (holder.beforeErasure ?? []).map(fn => [name, fn] as const) : []
    )
  )('%s: beforeErasure function %s is exported from the repo', (_modelName, functionName) => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    // A text match, not a type check: it accepts `export [async] function fn` and `export const fn`.
    const pattern = `export ((async )?function|const) ${functionName}([^A-Za-z0-9_]|$)`;
    const matches = execFileSync('git', ['grep', '-l', '-E', pattern, '--', '*.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(matches.trim()).not.toBe('');
  });
});
