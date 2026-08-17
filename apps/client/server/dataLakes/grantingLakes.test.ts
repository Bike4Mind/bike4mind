import { describe, it, expect } from 'vitest';
import type { DataLakeConfig, IFabFileDocument } from '@bike4mind/common';
import { grantingLakes, isFileInAccessibleLake } from './grantingLakes';

// A STATIC-registry lake: id matches a DATA_LAKES entry, so its fileTagPrefix is an OPEN prefix
// (shared KB, ownership-bypass by design).
const staticLake = {
  id: 'opti-knowledge',
  slug: 'opti-knowledge',
  name: 'Optimization Knowledge Base',
  fileTagPrefix: 'opti:',
  datalakeTag: 'datalake:opti-knowledge',
} as DataLakeConfig;

// A DYNAMIC (user-created) lake: id is NOT in DATA_LAKES, so its fileTagPrefix is SCOPED
// (user-controlled) and must never grant single-file access on its own - only its meta-tag does.
const dynamicLake = {
  id: 'team-alpha-lake',
  slug: 'team-alpha',
  name: 'Team Alpha',
  fileTagPrefix: 'teamalpha:',
  datalakeTag: 'datalake:team-alpha',
} as DataLakeConfig;

const fileWith = (tagNames: string[]) => ({ tags: tagNames.map(name => ({ name })) }) as unknown as IFabFileDocument;

describe('isFileInAccessibleLake (single-file lake authorization gate)', () => {
  it('grants a file carrying a static lake OPEN prefix (curated OptiHashi case)', () => {
    expect(isFileInAccessibleLake([staticLake], fileWith(['opti:family:scheduling']))).toBe(true);
  });

  it('grants a file carrying an accessible lake meta-tag (dynamic lake membership)', () => {
    expect(isFileInAccessibleLake([dynamicLake], fileWith(['datalake:team-alpha', 'teamalpha:notes']))).toBe(true);
  });

  it('does NOT grant on a dynamic lake SCOPED prefix alone (cross-tenant safety)', () => {
    // The file carries the dynamic lake's user-controlled prefix but NOT its meta-tag: a
    // colliding prefix from another tenant must not leak in.
    expect(isFileInAccessibleLake([dynamicLake], fileWith(['teamalpha:notes']))).toBe(false);
  });

  it('does NOT grant a file with unrelated tags', () => {
    expect(isFileInAccessibleLake([staticLake, dynamicLake], fileWith(['personal:draft']))).toBe(false);
  });

  it('does NOT grant when there are no accessible lakes', () => {
    expect(isFileInAccessibleLake([], fileWith(['opti:family:scheduling']))).toBe(false);
  });

  it('handles a file with no tags', () => {
    expect(isFileInAccessibleLake([staticLake], fileWith([]))).toBe(false);
  });
});

describe('grantingLakes (names the specific grantor(s), not just a boolean)', () => {
  // The same predicate as isFileInAccessibleLake, but the caller that needs to know WHICH lake
  // granted access - notably the lake-access-audit attribution - must use this, not a full-scope
  // fallback, or an open-prefix grant (which has no tag to reverse) over-attributes to every
  // accessible lake instead of the one that actually granted it.
  const otherDynamicLake = {
    id: 'team-beta-lake',
    slug: 'team-beta',
    name: 'Team Beta',
    fileTagPrefix: 'teambeta:',
    datalakeTag: 'datalake:team-beta',
  } as DataLakeConfig;

  it('names the one static lake whose OPEN prefix matched, not every accessible lake', () => {
    expect(grantingLakes([staticLake, dynamicLake], ['opti:family:scheduling']).map(l => l.id)).toEqual([
      'opti-knowledge',
    ]);
  });

  it('names the dynamic lake granted by its meta-tag', () => {
    expect(grantingLakes([staticLake, dynamicLake], ['datalake:team-alpha', 'teamalpha:notes']).map(l => l.id)).toEqual(
      ['team-alpha-lake']
    );
  });

  it('can name more than one grantor when tags match multiple lakes', () => {
    expect(
      grantingLakes([staticLake, dynamicLake, otherDynamicLake], ['opti:family:scheduling', 'datalake:team-beta'])
        .map(l => l.id)
        .sort()
    ).toEqual(['opti-knowledge', 'team-beta-lake']);
  });

  it('never names a dynamic lake from its scoped prefix alone (cross-tenant safety)', () => {
    expect(grantingLakes([dynamicLake], ['teamalpha:notes'])).toEqual([]);
  });

  it('returns empty for unrelated tags, an empty lake list, or no tags at all', () => {
    expect(grantingLakes([staticLake, dynamicLake], ['personal:draft'])).toEqual([]);
    expect(grantingLakes([], ['opti:family:scheduling'])).toEqual([]);
    expect(grantingLakes([staticLake], [])).toEqual([]);
  });
});
