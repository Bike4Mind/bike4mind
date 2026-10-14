import { describe, it, expect } from 'vitest';
import { driveIngestSkipReason, MAX_INGEST_FILE_BYTES } from './driveIngestLimits';

describe('driveIngestSkipReason', () => {
  const maxFileSize = 10 * 1024 * 1024;

  it.each([
    ['an unknown size is never skipped', undefined, maxFileSize, null],
    ['a file at the exact ingest cap is kept', MAX_INGEST_FILE_BYTES, 10 * MAX_INGEST_FILE_BYTES, null],
    [
      'a file one byte over the ingest cap is oversized',
      MAX_INGEST_FILE_BYTES + 1,
      10 * MAX_INGEST_FILE_BYTES,
      'oversized',
    ],
    ['a file at MaxFileSize is over the admin limit', maxFileSize, maxFileSize, 'exceeds_max_file_size'],
    ['a file one byte under MaxFileSize is kept', maxFileSize - 1, maxFileSize, null],
  ] as const)('%s', (_label, size, limit, expected) => {
    expect(driveIngestSkipReason(size, limit)).toBe(expected);
  });

  it('reports oversized ahead of the admin limit when a file breaks both', () => {
    expect(driveIngestSkipReason(MAX_INGEST_FILE_BYTES + 1, 1)).toBe('oversized');
  });
});
