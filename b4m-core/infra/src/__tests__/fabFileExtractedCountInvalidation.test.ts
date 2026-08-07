import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every site that rewrites a FabFile's bytes in place must also clear the cached extracted length.
 *
 * A stale `extractedCharCount` makes the pre-send attachment warning silent about a file that no
 * longer fits, which is the one failure that warning exists to prevent: an AI edit growing a 4k file
 * to 44k leaves the document saying 4,000, and the dry-run short-circuits to "fits".
 *
 * A source-pattern test, like fabFileModerationGate, and for the same reason: the first version of the
 * invalidation covered fabFileService/update and missed three live edit routes, while its own comment
 * claimed it was "the one place content is rewritten in place". Enumeration is the only thing that
 * catches that class of mistake, so this fails when a NEW rewrite site appears without the patch
 * rather than trusting anyone to remember.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PATCH = 'FAB_FILE_CONTENT_REWRITE_PATCH';

/**
 * Files that upload FabFile content. Each must reference the shared patch.
 *
 * `create.ts` and `createByUrl.ts` are absent on purpose: they write a file's FIRST bytes, so there is
 * no prior measurement to invalidate. A backup upload (writing the OLD bytes to a backup path) does not
 * change the live file either, which is why presence-of-`upload(` alone is not the rule.
 */
const REWRITE_SITES = [
  'apps/client/pages/api/fabfiles/[id]/apply-edit.ts',
  'apps/client/pages/api/fabfiles/[id]/edit.ts',
  'b4m-core/services/src/fabFileService/update.ts',
  'b4m-core/services/src/fabFileService/applyEdit.ts',
  'b4m-core/services/src/fabFileService/edit.ts',
];

/** Content-upload call shapes, used to spot a rewrite site nobody added to the list above. */
const UPLOAD_PATTERN = /(getFilesStorage\(\)\.upload\(|storage\.upload\()/;

/** First-write and backup paths: they upload bytes but invalidate nothing. */
const NOT_A_REWRITE = new Set([
  'b4m-core/services/src/fabFileService/create.ts',
  'b4m-core/services/src/fabFileService/createByUrl.ts',
]);

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

describe('every FabFile content rewrite clears the cached extracted length', () => {
  it.each(REWRITE_SITES)('%s references the shared invalidation patch', rel => {
    expect(read(rel)).toContain(PATCH);
  });

  // The list above is only as good as its completeness, so hunt for a site nobody listed.
  it('has no unlisted file that uploads FabFile content', () => {
    const searchRoots = ['apps/client/pages/api/fabfiles', 'b4m-core/services/src/fabFileService'];
    const found: string[] = [];

    const walk = (dir: string) => {
      const abs = path.join(REPO_ROOT, dir);
      if (!fs.existsSync(abs)) return;
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
          if (UPLOAD_PATTERN.test(read(rel))) found.push(rel.split(path.sep).join('/'));
        }
      }
    };
    searchRoots.forEach(walk);

    const unaccounted = found.filter(f => !REWRITE_SITES.includes(f) && !NOT_A_REWRITE.has(f));
    expect(
      unaccounted,
      `These upload FabFile content but are neither listed as rewrite sites nor excluded as first-write/backup. ` +
        `If one rewrites an existing file's bytes, spread ${PATCH} into its update and add it to REWRITE_SITES; ` +
        `if it only writes a new file or a backup copy, add it to NOT_A_REWRITE with a reason.`
    ).toEqual([]);
  });

  // undefined is stripped from a Mongoose $set, so that form of the fix silently changes nothing.
  it('clears with null rather than undefined', () => {
    const source = read('b4m-core/common/src/types/entities/FabFileTypes.ts');

    expect(source).toMatch(/FAB_FILE_CONTENT_REWRITE_PATCH\s*=\s*\{\s*extractedCharCount:\s*null\s*\}/);
  });
});
