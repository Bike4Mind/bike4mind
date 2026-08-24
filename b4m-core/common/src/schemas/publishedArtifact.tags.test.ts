import { describe, it, expect } from 'vitest';
import {
  normalizePublishedTag,
  normalizePublishedTags,
  PublishedTagsSchema,
  PUBLISHED_TAG_MAX_LENGTH,
  PUBLISHED_TAGS_MAX,
} from './publishedArtifact';

describe('normalizePublishedTag', () => {
  it('trims, lowercases and collapses inner whitespace', () => {
    expect(normalizePublishedTag('  Client   Work  ')).toBe('client work');
  });

  it('truncates to the max length', () => {
    expect(normalizePublishedTag('a'.repeat(200))).toHaveLength(PUBLISHED_TAG_MAX_LENGTH);
  });

  it('yields an empty string for whitespace-only input', () => {
    expect(normalizePublishedTag('   ')).toBe('');
  });
});

describe('normalizePublishedTags', () => {
  it('drops empties and dedupes case-insensitively, preserving order', () => {
    expect(normalizePublishedTags(['Design', '  ', 'design', 'Ops'])).toEqual(['design', 'ops']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: PUBLISHED_TAGS_MAX + 5 }, (_, i) => `tag-${i}`);
    expect(normalizePublishedTags(many)).toHaveLength(PUBLISHED_TAGS_MAX);
  });
});

describe('PublishedTagsSchema', () => {
  it('normalizes on parse so stored tags are always canonical', () => {
    expect(PublishedTagsSchema.parse([' A ', 'a', 'B'])).toEqual(['a', 'b']);
  });

  it('accepts an empty list (the clear-tags case)', () => {
    expect(PublishedTagsSchema.parse([])).toEqual([]);
  });

  it('rejects a non-array value', () => {
    expect(PublishedTagsSchema.safeParse('a,b').success).toBe(false);
  });
});
