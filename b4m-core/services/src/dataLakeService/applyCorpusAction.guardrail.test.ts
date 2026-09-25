import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * "Curator-initiated only. Nothing here runs unattended, and no detector may trigger these."
 *
 * A comment cannot hold that line and neither can a review: the failure mode is a future queue
 * handler or scheduled sweep picking up `applyCorpusAction` because it is exported from the
 * service index like everything else, and nothing going red. So this asserts it by scanning the
 * repository for importers.
 *
 * The allowlist is the shape of the rule, not a list of blessed files: exactly one HTTP route (a
 * human clicking in a review surface, or an API key acting for one) plus this module's own tests.
 * Adding a caller means adding it here, which is the point - it makes the decision deliberate and
 * visible in a diff rather than incidental.
 */
const ALLOWED = [
  'b4m-core/services/src/dataLakeService/applyCorpusAction.test.ts',
  'b4m-core/services/src/dataLakeService/applyCorpusAction.guardrail.test.ts',
  'b4m-core/services/src/dataLakeService/index.ts',
  'apps/client/pages/api/data-lakes/[id]/findings/[findingId]/corpus-action.ts',
];

/**
 * A CALL (`applyCorpusAction(`) or an IMPORT of the module (`.../applyCorpusAction'`), never a
 * prose mention. Several modules name this function in a doc comment to explain what they may not
 * do - `FabFileTypes` and `DataLakeCorpusActionTypes` both point here for the guardrail itself -
 * and counting those as callers would make the allowlist a list of files that mention the rule.
 */
const REFERENCE = String.raw`applyCorpusAction\(|applyCorpusAction'`;

/** Paths whose mere presence would mean an unattended caller, however it reached the function. */
const UNATTENDED = [
  /queueHandlers?\//i,
  /\/cron\//i,
  /cronHandlers?\//i,
  /scheduled/i,
  /packages\/scripts\/datalake\//i,
];

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function grepImporters(): string[] {
  let out = '';
  try {
    out = execFileSync(
      'git',
      // `--untracked`: a new caller is untracked before it is committed, and a guardrail that only
      // sees committed files would pass on the very diff that breaks it.
      ['grep', '-l', '--untracked', '-E', REFERENCE, '--', '*.ts', '*.tsx'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
  } catch (error) {
    // `git grep` exits 1 when nothing matched. Anything else is a real failure worth surfacing.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
  return out.split('\n').filter(Boolean);
}

describe('applyCorpusAction is reachable only by a curator', () => {
  const importers = grepImporters();

  it('is referenced somewhere, so a rename cannot make this test vacuously pass', () => {
    expect(importers).toContain('b4m-core/services/src/dataLakeService/index.ts');
    expect(importers).toContain('apps/client/pages/api/data-lakes/[id]/findings/[findingId]/corpus-action.ts');
  });

  it('is referenced by no file outside the allowlist', () => {
    expect(importers.filter(f => !ALLOWED.includes(f))).toEqual([]);
  });

  it('is referenced by nothing that runs unattended', () => {
    expect(importers.filter(f => UNATTENDED.some(p => p.test(f)))).toEqual([]);
  });
});
