import { describe, it, expect } from 'vitest';
import {
  DATA_LAKES,
  DataLakeConfig,
  getAccessibleDataLakes,
  getDataLakeTags,
  lakeMatchesAccess,
  isReservedTagPrefix,
  normalizeEntitlementKey,
  normalizeTagPrefix,
  toDataLakeConfig,
  tagPrefixesOverlap,
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

describe('tagPrefixesOverlap', () => {
  it.each([
    ['identical prefixes', 'acme:', 'acme:'],
    ['padded values', '  acme:  ', 'acme:'],
    ['a nested prefix', 'docs:legal:', 'docs:'],
    ['a nested prefix the other way round', 'docs:', 'docs:legal:'],
  ])('reports %s as overlapping', (_label, a, b) => {
    expect(tagPrefixesOverlap(a, b)).toBe(true);
  });

  it.each([
    ['unrelated prefixes', 'globex:', 'acme:'],
    ['a shared word that is not a prefix boundary', 'acme-docs:', 'acme:x:'],
    // The predicate builds an unflagged ^regex, so these two cannot reach each other's tags.
    ['prefixes differing only in case', 'ACME:', 'acme:'],
  ])('reports %s as safe', (_label, a, b) => {
    expect(tagPrefixesOverlap(a, b)).toBe(false);
  });

  it.each([
    ['empty', '', 'acme:'],
    ['whitespace only', '   ', 'acme:'],
    ['missing the trailing colon', 'acme', 'acme:'],
    ['null', null, 'acme:'],
    ['undefined', undefined, 'acme:'],
  ])('never overlaps when one side is %s, since no query arm is built from it', (_label, a, b) => {
    expect(tagPrefixesOverlap(a, b)).toBe(false);
    expect(tagPrefixesOverlap(b, a)).toBe(false);
  });
});
