/**
 * package.json "exports" and tsdown.config.ts "entry" are a hand-synced pair:
 * declaring a subpath without building an entry for it produces a subpath that
 * only fails at runtime, in the consumer, with ERR_MODULE_NOT_FOUND. Nothing
 * else in the build catches that, so it is pinned here.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const packageJson = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, { import: { default: string; types: string }; require: { default: string; types: string } }>;
};

// tsdown entries are plain string literals in the config's `entry` array.
const tsdownConfig = fs.readFileSync(path.join(PKG_ROOT, 'tsdown.config.ts'), 'utf8');
const entries = [...tsdownConfig.matchAll(/'(src\/[^']+\.ts)'/g)].map(match => match[1]);

/** 'src/llm/index.ts' -> 'llm/index' -- the shape the exports map points at under dist/. */
const distStem = (entry: string) => entry.replace(/^src\//, '').replace(/\.ts$/, '');

describe('@bike4mind/services package exports', () => {
  const builtStems = new Set(entries.map(distStem));

  it.each(Object.entries(packageJson.exports))('%s is built by a tsdown entry', (_subpath, target) => {
    const stem = target.import.default.replace('./dist/', '').replace(/\.mjs$/, '');
    expect(builtStems).toContain(stem);
  });

  it('declares matching esm and cjs targets for every subpath', () => {
    for (const [subpath, target] of Object.entries(packageJson.exports)) {
      const stem = target.import.default.replace('./dist/', '').replace(/\.mjs$/, '');
      expect(target.import.types, subpath).toBe(`./dist/${stem}.d.mts`);
      expect(target.require.default, subpath).toBe(`./dist/${stem}.cjs`);
      expect(target.require.types, subpath).toBe(`./dist/${stem}.d.cts`);
    }
  });

  it('has no tsdown entry that is unreachable from the exports map', () => {
    const exported = new Set(
      Object.values(packageJson.exports).map(t => t.import.default.replace('./dist/', '').replace(/\.mjs$/, ''))
    );
    expect(entries.map(distStem).filter(stem => !exported.has(stem))).toEqual([]);
  });
});
