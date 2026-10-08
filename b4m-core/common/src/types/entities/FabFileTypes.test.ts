import { describe, expect, it } from 'vitest';
import { FAB_FILE_TYPE_FILTERS, isFabFileTypeFilter } from './FabFileTypes';

describe('FAB_FILE_TYPE_FILTERS', () => {
  it('lists every Files type filter, video included', () => {
    expect(FAB_FILE_TYPE_FILTERS).toEqual([
      'text',
      'pdf',
      'url',
      'image',
      'excel',
      'word',
      'json',
      'csv',
      'markdown',
      'code',
      'audio',
      'video',
    ]);
  });

  it.each(['video', 'audio', 'pdf'])('accepts %s', value => {
    expect(isFabFileTypeFilter(value)).toBe(true);
  });

  it.each(['all', 'VIDEO', '', 3, undefined, null])('rejects %s', value => {
    expect(isFabFileTypeFilter(value)).toBe(false);
  });
});
