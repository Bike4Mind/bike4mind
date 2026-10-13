import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guards the single storageLimit conversion: `storageLimit` is stored in decimal MB, and every
 * site turns it into bytes through storageLimitToBytes (b4m-core/common/src/constants/storage.ts).
 * An inline MiB factor (1024 * 1024) on the stored limit is how the admin Users screens drifted while
 * enforcement used 1e6, so any inline factor next to a storageLimit identifier fails here.
 *
 * Residual: a factor carried through another variable (`const f = 1024 * 1024; limit * f`) is not
 * caught - this is a tripwire for the shape that actually drifted, not a type-level proof.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SELF_PATH = path.relative(REPO_ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const ALLOWLIST = new Set(['b4m-core/common/src/constants/storage.ts', SELF_PATH]);

const FACTOR = String.raw`(?:1024|1_?000_?000|1e6)\b`;
const INLINE_CONVERSION = [
  new RegExp(String.raw`storageLimit[^;]*\*\s*${FACTOR}`, 'i'),
  new RegExp(String.raw`\b${FACTOR}\s*\*[^;]*storageLimit`, 'i'),
];

const hasInlineConversion = (line: string) => INLINE_CONVERSION.some(re => re.test(line));

describe('storageLimit converts to bytes only through storageLimitToBytes', () => {
  it('matches the inline shapes that drifted, and not the helper', () => {
    // Built by concatenation so this file does not itself trip a repo-wide grep for the shape.
    const SL = 'storage' + 'Limit';
    const bad = [
      `user.${SL} * 1024 * 1024`,
      `(user?.${SL} ?? 1000) * 1000000`,
      `(user.${SL} ?? 1000) * 1_000_000`,
      `${SL}Mb * 1e6`,
      `1024 * 1024 * org.${SL}`,
    ];
    const good = [
      `storageLimitToBytes(user.${SL} ?? DEFAULT_STORAGE_LIMIT_MB)`,
      `computeStoragePercent(storageLimitToBytes(limitMb) * 2, limitMb)`,
      `maxFileBytes / 1024 / 1024`,
      `const x = user.${SL}; const y = size * 1024;`,
    ];
    expect(bad.filter(l => !hasInlineConversion(l))).toEqual([]);
    expect(good.filter(hasInlineConversion)).toEqual([]);
  });

  it('has no inline storageLimit byte factor in tracked source', () => {
    const files = execSync(
      'git ls-files -- "apps/*.ts" "apps/*.tsx" "b4m-core/*.ts" "b4m-core/*.tsx" "packages/*.ts" "packages/*.tsx"',
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }
    )
      .split('\n')
      .filter(f => f && !ALLOWLIST.has(f));

    const hits: string[] = [];
    for (const file of files) {
      const abs = path.join(REPO_ROOT, file);
      if (!fs.existsSync(abs)) continue;
      const text = fs.readFileSync(abs, 'utf8');
      if (!/storageLimit/i.test(text)) continue;
      text.split('\n').forEach((line, i) => {
        if (hasInlineConversion(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }

    expect(hits, 'Convert with storageLimitToBytes from @bike4mind/common instead of an inline factor.').toEqual([]);
  });
});
