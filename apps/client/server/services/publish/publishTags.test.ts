import { describe, it, expect } from 'vitest';
import { normalizePublishTag, normalizePublishTags, PUBLISH_TAGS_MAX, PUBLISH_TAG_MAX_LENGTH } from '@bike4mind/common';

/**
 * The tag normalization contract. Every write path - the UI, the PATCH, the publish call the CLI
 * skill uses - runs input through these, so a tag typed in one door and a tag sent through
 * another must land identically. Two spellings of one label is the failure this prevents.
 */
describe('normalizePublishTag', () => {
  it('trims, collapses internal whitespace and lowercases', () => {
    expect(normalizePublishTag('  NorthWind  ')).toBe('northwind');
    expect(normalizePublishTag('Security   Review')).toBe('security review');
    expect(normalizePublishTag('WEEKLY')).toBe('weekly');
  });

  it('makes differently-typed spellings of one label converge', () => {
    const spellings = ['NorthWind', 'northwind', ' NORTHWIND ', 'NorthWind '];
    expect(new Set(spellings.map(normalizePublishTag)).size).toBe(1);
  });
});

describe('normalizePublishTags', () => {
  it('dedupes case-insensitively, keeping the first occurrence', () => {
    expect(normalizePublishTags(['NorthWind', 'security', 'northwind'])).toEqual(['northwind', 'security']);
  });

  it('drops blanks rather than storing empty chips', () => {
    expect(normalizePublishTags(['', '   ', 'real'])).toEqual(['real']);
  });

  it('drops an over-long tag instead of truncating it to something the author did not write', () => {
    const tooLong = 'x'.repeat(PUBLISH_TAG_MAX_LENGTH + 1);
    expect(normalizePublishTags([tooLong, 'ok'])).toEqual(['ok']);
    expect(normalizePublishTags(['y'.repeat(PUBLISH_TAG_MAX_LENGTH)])).toHaveLength(1);
  });

  it('caps the list, so one caller cannot make a row of a hundred chips', () => {
    const many = Array.from({ length: PUBLISH_TAGS_MAX + 10 }, (_, i) => `tag-${i}`);
    expect(normalizePublishTags(many)).toHaveLength(PUBLISH_TAGS_MAX);
  });

  it('is idempotent - normalizing stored tags again changes nothing', () => {
    const once = normalizePublishTags(['  Weekly ', 'NorthWind', 'northwind', '']);
    expect(normalizePublishTags(once)).toEqual(once);
  });
});
