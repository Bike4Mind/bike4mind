import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType, satisfiesTagPrefix } from '@bike4mind/common';
import { createMongoServer } from '../__test__/createMongoServer';
import { FabFile } from '../models/content/FabFileModel';
import { buildLacksContentPrefixTagFilter } from './dataLakeLifecycleScope';

/**
 * Parity guard: `buildLacksContentPrefixTagFilter` is the datastore mirror of
 * `satisfiesTagPrefix`, negated. The backfill migration selects with the filter and the write-door
 * reconciler decides with the predicate, so any disagreement means the backfill stamps a file the
 * live doors would have left alone, or skips one they would have stamped.
 *
 * Run against a real server rather than asserted structurally, because the disagreements that
 * matter are in Mongo's regex semantics, not in the shape of the query object - `.` excluding
 * newlines is one this caught.
 */

// `datalake:` is not a prefix the stamp gate ever clears, but the filter is exported and parity
// should not depend on every future caller knowing that.
const PREFIXES = ['acme:', 'a:', 'datalake:', 'ACME:'];

// [label, tag names on the file]. Each is evaluated BOTH ways; the assertion is that the two
// answers are opposites, so a case only has to be interesting, not pre-classified.
const CASES: [string, string[]][] = [
  ['no tags at all', []],
  ['only the membership meta-tag', ['datalake:acme']],
  ['a plain content tag', ['acme:legal']],
  ['a nested content tag', ['acme:legal:2024']],
  ['a content tag among unrelated ones', ['important', 'globex:x', 'acme:legal']],
  ['only tags outside the prefix', ['important', 'globex:legal']],
  ['a bare prefix with no suffix', ['acme:']],
  ['a bare prefix alongside the meta-tag', ['acme:', 'datalake:acme']],
  ['a differently-cased prefix', ['ACME:legal']],
  ['a prefix that is only a substring', ['not-acme:legal']],
  ['a suffix that begins with a separator', ['acme::odd']],
  // `.` would not match this, so a `^acme:.` filter reported it uncategorized while the
  // predicate reported it satisfied.
  ['a suffix beginning with a newline', ['acme:\nlegal']],
  ['a suffix beginning with a space', ['acme: legal']],
  ['a nested tag under a shorter prefix', ['a:b:c']],
  ['a meta-tag in mixed case', ['DataLake:acme']],
  ['a meta-tag and a content tag together', ['datalake:acme', 'acme:legal']],
];

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await FabFile.create(
    CASES.map(([label, tags], i) => ({
      userId: 'owner',
      fileName: `f${i}.txt`,
      type: KnowledgeType.FILE,
      // The label rides on the document so a failure names the case rather than an index.
      filePath: label,
      tags: tags.map(name => ({ name, strength: 1 })),
    }))
  );
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);

describe('buildLacksContentPrefixTagFilter', () => {
  it.each(PREFIXES)('selects exactly the files satisfiesTagPrefix reports as uncategorized under %s', async prefix => {
    const selected = await FabFile.find(buildLacksContentPrefixTagFilter(prefix)).select('filePath').lean();
    const selectedLabels = new Set(selected.map(f => f.filePath));

    const disagreements = CASES.filter(
      ([label, tags]) => satisfiesTagPrefix(tags, prefix) === selectedLabels.has(label)
    ).map(([label, tags]) => `${label} [${tags.join(', ')}]`);

    expect(disagreements).toEqual([]);
    // Guards the assertion above against a filter that matches nothing: every case would then
    // "agree" only if every case were satisfied, and a typo'd field name matching nothing is the
    // realistic failure. `datalake:` and `ACME:` satisfy no case, so only the real prefixes can
    // assert the lower bound.
    if (prefix === 'acme:' || prefix === 'a:') expect(selectedLabels.size).toBeLessThan(CASES.length);
    expect(selectedLabels.size).toBeGreaterThan(0);
  });

  it('escapes regex metacharacters in a user-chosen prefix', async () => {
    // `a.c:` must not match `abc:legal`. Without escaping, the `.` is a wildcard and this file
    // would look categorized, so the backfill would skip a lake that genuinely needs stamping.
    await FabFile.create({
      userId: 'owner',
      fileName: 'meta.txt',
      type: KnowledgeType.FILE,
      filePath: 'metachar',
      tags: [{ name: 'abc:legal', strength: 1 }],
    });

    const selected = await FabFile.find(buildLacksContentPrefixTagFilter('a.c:')).select('filePath').lean();
    expect(selected.map(f => f.filePath)).toContain('metachar');
  });
});
