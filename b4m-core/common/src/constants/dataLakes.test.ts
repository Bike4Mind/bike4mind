import { describe, it, expect } from 'vitest';
import {
  DATA_LAKES,
  DataLakeConfig,
  getAccessibleDataLakes,
  getDataLakeTags,
  lakeMatchesAccess,
  isDatalakeMetaTag,
  isRegistryDatalakeTag,
  isReservedTagPrefix,
  normalizeEntitlementKey,
  normalizeTagPrefix,
  preserveDataLakeMembership,
  toDataLakeConfig,
} from './dataLakes';

// A dynamic (DB-registered) lake config builder. Passing dynamicDataLakes bypasses the
// hardcoded DATA_LAKES fallbacks so each case tests exactly the lakes it declares.
const lake = (overrides: Partial<DataLakeConfig> & Pick<DataLakeConfig, 'id'>): DataLakeConfig => ({
  slug: overrides.id,
  name: overrides.id,
  fileTagPrefix: `${overrides.id}:`,
  datalakeTag: `datalake:${overrides.id}`,
  ...overrides,
});

describe('getAccessibleDataLakes — any-of-declared-requirements rule', () => {
  it('a lake with NO requirement is public', () => {
    const lakes = [lake({ id: 'public' })];
    expect(getAccessibleDataLakes([], lakes, []).map(l => l.id)).toEqual(['public']);
  });

  it('a tag-only lake matches on the tag (Opti behavior, unchanged)', () => {
    // Use a tag that does NOT collide with the hardcoded DATA_LAKES (both 'Opti'), which
    // merge in as fallbacks, so this case tests exactly the one dynamic lake.
    const lakes = [lake({ id: 'team', requiredUserTag: 'special-team' })];
    expect(getAccessibleDataLakes(['special-team'], lakes).map(l => l.id)).toEqual(['team']);
    expect(getAccessibleDataLakes(['other'], lakes)).toEqual([]);
  });

  it('an entitlement-only lake is NOT public — it is gated by the key', () => {
    const lakes = [lake({ id: 'ent', requiredEntitlement: 'product:pro' })];
    // No keys -> excluded (the critical not-public case).
    expect(getAccessibleDataLakes(['anything'], lakes, [])).toEqual([]);
    expect(getAccessibleDataLakes(['anything'], lakes)).toEqual([]); // undefined keys, no throw
    // Holding the key -> granted.
    expect(getAccessibleDataLakes([], lakes, ['product:pro']).map(l => l.id)).toEqual(['ent']);
  });

  it('a both-fields lake (medlib shape) grants via EITHER the tag OR the entitlement key', () => {
    const lakes = [lake({ id: 'medlib', requiredUserTag: 'medlib', requiredEntitlement: 'medlib:pro' })];
    // Comp-tag holder, no subscription -> matches via tag.
    expect(getAccessibleDataLakes(['medlib'], lakes, []).map(l => l.id)).toEqual(['medlib']);
    // Tag-less subscriber -> matches via entitlement key.
    expect(getAccessibleDataLakes([], lakes, ['medlib:pro']).map(l => l.id)).toEqual(['medlib']);
    // Neither -> denied.
    expect(getAccessibleDataLakes(['unrelated'], lakes, ['unrelated:key'])).toEqual([]);
  });

  it('normalizes entitlement keys + requiredEntitlement on both sides (case/whitespace insensitive)', () => {
    const lakes = [lake({ id: 'ent', requiredEntitlement: 'Product:PRO' })];
    expect(getAccessibleDataLakes([], lakes, ['  product:pro  ']).map(l => l.id)).toEqual(['ent']);
  });

  it('getDataLakeTags forwards entitlementKeys (tags + prefixes stay consistent)', () => {
    const lakes = [lake({ id: 'medlib', requiredEntitlement: 'medlib:pro', datalakeTag: 'datalake:medlib' })];
    expect(getDataLakeTags([], lakes, ['medlib:pro'])).toEqual(['datalake:medlib']);
    expect(getDataLakeTags([], lakes, [])).toEqual([]);
  });

  it('regression: the hardcoded DATA_LAKES (Opti) are unaffected by the entitlement arm', () => {
    // No dynamicDataLakes -> operates on the real DATA_LAKES constant. An Opti tag-holder
    // still gets the opti lake even with empty entitlementKeys (the new hasRequirement
    // branch must not drop tag-only lakes), and a non-Opti user gets neither.
    expect(
      getAccessibleDataLakes(['Opti'], undefined, [])
        .map(l => l.id)
        .sort()
    ).toEqual(['opti-knowledge']);
    expect(
      getAccessibleDataLakes(['Opti'])
        .map(l => l.id)
        .sort()
    ).toEqual(['opti-knowledge']);
    expect(
      getAccessibleDataLakes([], undefined, ['anything:pro']).filter(l => DATA_LAKES.some(d => d.id === l.id))
    ).toEqual([]);
  });
});

describe('lakeMatchesAccess — the one shared any-of predicate (list + canAccessLake + findAccessible)', () => {
  // Inputs are PRE-NORMALIZED (tags lowercased; keys via normalizeEntitlementKey) by callers.
  it('a lake with no requirement matches anyone', () => {
    expect(lakeMatchesAccess({}, [], [])).toBe(true);
  });

  it('matches via the required tag', () => {
    expect(lakeMatchesAccess({ requiredUserTag: 'Opti' }, ['opti'], [])).toBe(true);
    expect(lakeMatchesAccess({ requiredUserTag: 'Opti' }, ['other'], [])).toBe(false);
  });

  it('matches via the required entitlement key', () => {
    expect(lakeMatchesAccess({ requiredEntitlement: 'product:pro' }, [], ['product:pro'])).toBe(true);
    expect(lakeMatchesAccess({ requiredEntitlement: 'product:pro' }, [], ['other:pro'])).toBe(false);
  });

  it('any-of: a both-fields lake matches if EITHER the tag OR the key is held', () => {
    const l = { requiredUserTag: 'medlib', requiredEntitlement: 'medlib:pro' };
    expect(lakeMatchesAccess(l, ['medlib'], [])).toBe(true); // tag only
    expect(lakeMatchesAccess(l, [], ['medlib:pro'])).toBe(true); // key only
    expect(lakeMatchesAccess(l, [], [])).toBe(false); // neither
  });

  it('an entitlement-only lake is NOT public (no key held → denied)', () => {
    expect(lakeMatchesAccess({ requiredEntitlement: 'product:pro' }, ['anything'], [])).toBe(false);
  });
});

describe('toDataLakeConfig', () => {
  it('carries requiredEntitlement through the projection', () => {
    const config = toDataLakeConfig({
      id: 'l',
      slug: 'l',
      name: 'L',
      requiredUserTag: 'tag',
      requiredEntitlement: 'product:pro',
      fileTagPrefix: 'l:',
      datalakeTag: 'datalake:l',
    });
    expect(config.requiredEntitlement).toBe('product:pro');
    expect(config.requiredUserTag).toBe('tag');
  });

  // The projection dropped `slug`, so the lake list returned lakes without a slug.
  // The Add-files (append) wizard reads `lake.slug` to send `dataLakeSlug`; without it the
  // server never resolved the lake tag and uploaded files were never registered to the lake.
  it('carries slug through the projection (append-mode upload depends on it)', () => {
    const config = toDataLakeConfig({
      id: 'lake1',
      slug: 'acme-robotics-kb',
      name: 'Acme',
      fileTagPrefix: 'acme:',
      datalakeTag: 'datalake:acme-robotics-kb',
    });
    expect(config.slug).toBe('acme-robotics-kb');
  });

  it('carries description through the projection (so the list endpoint round-trips it to the Settings form)', () => {
    const config = toDataLakeConfig({
      id: 'l',
      slug: 'l',
      name: 'L',
      fileTagPrefix: 'l:',
      datalakeTag: 'datalake:l',
      description: 'A lake of things',
    });
    expect(config.description).toBe('A lake of things');
  });

  it('leaves description undefined when the source has none', () => {
    const config = toDataLakeConfig({
      id: 'l',
      slug: 'l',
      name: 'L',
      fileTagPrefix: 'l:',
      datalakeTag: 'datalake:l',
    });
    expect(config.description).toBeUndefined();
  });
});

describe('normalizeEntitlementKey', () => {
  it('trims and lowercases', () => {
    expect(normalizeEntitlementKey('  MedLib:Pro ')).toBe('medlib:pro');
  });
});

describe('normalizeTagPrefix', () => {
  it('returns the trimmed prefix when it ends with a colon', () => {
    expect(normalizeTagPrefix('acme:')).toBe('acme:');
    expect(normalizeTagPrefix('  acme:  ')).toBe('acme:');
  });

  // Read scoping and the removal write path share this, so anything rejected here is a
  // prefix no query matches AND no removal clears.
  it.each([
    ['', 'empty would match every tag'],
    ['   ', 'whitespace-only collapses to empty'],
    ['acme', 'no trailing colon would match unrelated tags like acmex:'],
    [undefined, 'absent'],
    [null, 'null'],
  ])('rejects %o (%s)', prefix => {
    expect(normalizeTagPrefix(prefix as string | undefined | null)).toBeNull();
  });
});

describe('isReservedTagPrefix', () => {
  it.each(['datalake:', 'datalake:x:', '  datalake:'])('flags %o as reserved', prefix => {
    expect(isReservedTagPrefix(prefix)).toBe(true);
  });

  it.each(['acme:', 'opti:', 'data:', undefined, null])('allows %o', prefix => {
    expect(isReservedTagPrefix(prefix as string | undefined | null)).toBe(false);
  });
});

describe('isDatalakeMetaTag', () => {
  it.each(['datalake:lake', 'datalake:org:lake', 'DataLake:Lake'])('flags %o as a meta-tag', name => {
    expect(isDatalakeMetaTag(name)).toBe(true);
  });

  // The write paths hand over raw body entries, so a non-string must read as "not a meta-tag"
  // rather than throwing - the gate then treats it as removing membership and fails closed.
  it.each([undefined, null, 42, {}, ['datalake:lake'], 'acme:notes', ' datalake:lake'])('does not flag %o', name => {
    expect(isDatalakeMetaTag(name)).toBe(false);
  });
});

describe('isRegistryDatalakeTag', () => {
  it('recognizes a built-in lake, whose meta-tag resolves to no Mongo document', () => {
    expect(isRegistryDatalakeTag(DATA_LAKES[0].datalakeTag)).toBe(true);
  });

  it.each(['datalake:org:persisted', 'datalake:persisted', 'acme:notes', ''])('rejects %o', tag => {
    expect(isRegistryDatalakeTag(tag)).toBe(false);
  });
});

describe('preserveDataLakeMembership', () => {
  const tag = (name: string) => ({ name, strength: 1 });

  it('carries the stored membership forward when the source omits it', () => {
    expect(preserveDataLakeMembership([tag('notes')], [tag('datalake:lake'), tag('stale')])).toEqual([
      tag('notes'),
      tag('datalake:lake'),
    ]);
  });

  // A system job has no actor to authorize against, so a meta-tag it supplies must not confer
  // membership the user-facing write paths would have gated.
  it('drops a meta-tag supplied by the source', () => {
    expect(preserveDataLakeMembership([tag('notes'), tag('datalake:injected')], [])).toEqual([tag('notes')]);
  });

  it('keeps a stored meta-tag even when the source supplies a different one', () => {
    expect(preserveDataLakeMembership([tag('datalake:injected')], [tag('datalake:real')])).toEqual([
      tag('datalake:real'),
    ]);
  });

  it.each([
    [undefined, undefined],
    [null, null],
  ])('treats %o / %o as empty', (source, stored) => {
    expect(preserveDataLakeMembership(source, stored)).toEqual([]);
  });

  it('tolerates malformed entries without throwing', () => {
    const stored = [null, { name: null }, 42, tag('datalake:real')] as unknown as { name?: unknown }[];
    expect(preserveDataLakeMembership([], stored)).toEqual([tag('datalake:real')]);
  });

  // `tags` is a schema-less [Object] array, so a legacy row can lack `strength` - but the update
  // path parses tags with a strict {name, strength} schema and the only caller rethrows the
  // resulting error, so one such row would permanently break summarization.
  it('gives a stored tag with no numeric strength a usable one', () => {
    const stored = [{ name: 'datalake:legacy' }, { name: 'datalake:nan', strength: Number.NaN }] as unknown as {
      name?: unknown;
    }[];
    expect(preserveDataLakeMembership([], stored)).toEqual([
      { name: 'datalake:legacy', strength: 1 },
      { name: 'datalake:nan', strength: 1 },
    ]);
  });

  // A malformed SOURCE entry survives the meta-tag filter (it is not a meta-tag), so without a
  // name check it would reach the strict update schema as {name: null} and throw.
  it('drops a source tag whose name is not a string', () => {
    const source = [{ name: null }, { name: 42 }, { name: 'ok', strength: 2 }] as unknown as { name?: unknown }[];
    expect(preserveDataLakeMembership(source, [])).toEqual([{ name: 'ok', strength: 2 }]);
  });

  it('keeps a real strength untouched, including zero', () => {
    const stored = [{ name: 'datalake:zero', strength: 0 }];
    expect(preserveDataLakeMembership([], stored)).toEqual([{ name: 'datalake:zero', strength: 0 }]);
  });

  it('recognizes a registry tag whatever its case, since env-supplied entries are unnormalized', () => {
    expect(isRegistryDatalakeTag(DATA_LAKES[0].datalakeTag.toUpperCase())).toBe(true);
  });
});
