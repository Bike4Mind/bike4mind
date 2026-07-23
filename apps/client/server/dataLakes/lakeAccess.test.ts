import { describe, it, expect } from 'vitest';
import type { DataLakeConfig, IFabFileDocument } from '@bike4mind/common';
import { isFileInAccessibleLake } from './index';

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
