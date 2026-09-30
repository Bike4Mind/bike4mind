import { describe, it, expect } from 'vitest';
import { DataLakeSearchRequestSchema } from './dataLakePublic';
import { MAX_LAKE_FILE_TAG_NAME_LENGTH, MAX_TAXONOMY_TAGS } from '../constants/dataLakes';

describe('DataLakeSearchRequestSchema tags bound', () => {
  it('accepts a tags array at the taxonomy limits', () => {
    const result = DataLakeSearchRequestSchema.safeParse({
      query: 'refund policy',
      tags: [
        'a'.repeat(MAX_LAKE_FILE_TAG_NAME_LENGTH),
        ...Array.from({ length: MAX_TAXONOMY_TAGS - 1 }, (_, i) => `tag-${i}`),
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a tags array past the taxonomy count limit', () => {
    const result = DataLakeSearchRequestSchema.safeParse({
      query: 'refund policy',
      tags: Array.from({ length: MAX_TAXONOMY_TAGS + 1 }, (_, i) => `tag-${i}`),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a single tag longer than the taxonomy name limit', () => {
    const result = DataLakeSearchRequestSchema.safeParse({
      query: 'refund policy',
      tags: ['a'.repeat(MAX_LAKE_FILE_TAG_NAME_LENGTH + 1)],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty-string tag', () => {
    const result = DataLakeSearchRequestSchema.safeParse({
      query: 'refund policy',
      tags: [''],
    });
    expect(result.success).toBe(false);
  });
});
