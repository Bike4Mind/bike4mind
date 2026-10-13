import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guards the single storageLimit conversion: `storageLimit` is stored in decimal MB, and every
 * site turns it into bytes through storageLimitToBytes (b4m-core/common/src/constants/storage.ts).
 * An inline MiB factor (1024 * 1024) on the stored limit is how the admin Users screens drifted while
 * enforcement used 1e6, so any inline factor near a storageLimit identifier fails here.
 *
 * Matches run over whole files so a Prettier-wrapped expression is still caught. The gap between the
 * identifier and the factor stops at `;`, `,`, `{` or `}` (and at 80 chars) so a sibling field in the
 * same object literal or JSX tag does not count.
 *
 * Residual: a factor carried through another identifier (`const f = 1024 * 1024; limit * f`, or a
 * named constant like `* MB`) is not caught - this is a tripwire for the shapes that actually drift,
 * not a type-level proof.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SELF_PATH = path.relative(REPO_ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const ALLOWLIST = new Set(['b4m-core/common/src/constants/storage.ts', SELF_PATH]);

const FACTOR = String.raw`(?:1024|1_?048_?576|1_?000_?000|1e\+?6|1000\s*\*\s*1000|2\s*\*\*\s*20)\b`;
const LIMIT = String.raw`storageLimit(?!ToBytes)`;
const GAP = String.raw`[^;,{}]{0,80}?`;
const INLINE_CONVERSION = [
  new RegExp(String.raw`${LIMIT}${GAP}\*\s*${FACTOR}`, 'gi'),
  new RegExp(String.raw`\b${FACTOR}\s*\*${GAP}${LIMIT}`, 'gi'),
];

/** Returns the 0-based offset of each inline conversion in `text`. */
const findInlineConversions = (text: string): number[] =>
  INLINE_CONVERSION.flatMap(re => [...text.matchAll(re)].map(m => m.index ?? 0));

const hasInlineConversion = (text: string) => findInlineConversions(text).length > 0;

describe('storageLimit converts to bytes only through storageLimitToBytes', () => {
  it('matches the inline shapes that drift, and not the helper', () => {
    // Built by concatenation so this file does not itself trip a repo-wide grep for the shape.
    const SL = 'storage' + 'Limit';
    const bad = [
      `user.${SL} * 1024 * 1024`,
      `(user?.${SL} ?? 1000) * 1000000`,
      `(user.${SL} ?? 1000) * 1_000_000`,
      `${SL}Mb * 1e6`,
      `1024 * 1024 * org.${SL}`,
      `user.${SL} * 1048576`,
      `user.${SL} * 1_048_576`,
      `(user.${SL} ?? 1000) * 1000 * 1000`,
      `user.${SL} * 2 ** 20`,
      `const bytes =\n  (user.${SL} ??\n    DEFAULT_STORAGE_LIMIT_MB) *\n  1024 *\n  1024;`,
    ];
    const good = [
      `storageLimitToBytes(user.${SL} ?? DEFAULT_STORAGE_LIMIT_MB)`,
      `computeStoragePercent(storageLimitToBytes(limitMb) * 2, limitMb)`,
      `maxFileBytes / 1024 / 1024`,
      `const x = user.${SL}; const y = size * 1024;`,
      `{ ${SL}: 1, currentStorageSize: 5 * 1024 * 1024 }`,
      `<Bar limit={storageLimitToBytes(x)} max={MAX * 1024} />`,
      `user.${SL} * 10240`,
    ];
    expect(bad.filter(l => !hasInlineConversion(l))).toEqual([]);
    expect(good.filter(hasInlineConversion)).toEqual([]);
  });

  it('has no inline storageLimit byte factor in tracked source', () => {
    const files = execSync('git ls-files -- "*.ts" "*.tsx" "*.mts" "*.cts" "*.js" "*.mjs" "*.cjs"', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(f => f && !ALLOWLIST.has(f));

    const hits: string[] = [];
    for (const file of files) {
      const abs = path.join(REPO_ROOT, file);
      if (!fs.existsSync(abs)) continue;
      const text = fs.readFileSync(abs, 'utf8');
      if (!/storageLimit/i.test(text)) continue;
      for (const offset of findInlineConversions(text)) {
        const lineNo = text.slice(0, offset).split('\n').length;
        hits.push(`${file}:${lineNo}: ${text.split('\n')[lineNo - 1].trim()}`);
      }
    }

    expect(hits, 'Convert with storageLimitToBytes from @bike4mind/common instead of an inline factor.').toEqual([]);
  });
});
