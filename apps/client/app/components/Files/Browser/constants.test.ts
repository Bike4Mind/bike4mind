import { describe, expect, it } from 'vitest';
import { FAB_FILE_TYPE_FILTERS } from '@bike4mind/common';
import { FILE_TYPE_OPTIONS } from './constants';

describe('FILE_TYPE_OPTIONS', () => {
  it('offers "all" plus every type filter the server accepts, in order', () => {
    expect(FILE_TYPE_OPTIONS.map(option => option.value)).toEqual(['all', ...FAB_FILE_TYPE_FILTERS]);
  });

  it('labels the video filter', () => {
    expect(FILE_TYPE_OPTIONS).toContainEqual({ value: 'video', label: 'Video' });
  });
});
