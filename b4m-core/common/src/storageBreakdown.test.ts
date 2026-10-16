import { describe, it, expect } from 'vitest';
import { buildStorageBreakdownBuckets, generatedMediaKindOf, type StorageUsageGroup } from './storageBreakdown';
import { FabFileSourceType } from './types/entities/FabFileTypes';

const group = (over: Partial<StorageUsageGroup>): StorageUsageGroup => ({
  sourceType: null,
  sourceLakeId: null,
  mimeType: null,
  archived: false,
  bytes: 0,
  fileCount: 1,
  ...over,
});

describe('generatedMediaKindOf', () => {
  it.each([
    ['image/png', 'image'],
    ['AUDIO/MPEG', 'audio'],
    ['video/mp4', 'video'],
    ['application/pdf', 'document'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'document'],
    ['text/markdown', 'document'],
    ['application/octet-stream', 'other'],
    ['application/vnd.rar', 'other'],
    [null, 'other'],
  ])('%s -> %s', (mime, kind) => {
    expect(generatedMediaKindOf(mime)).toBe(kind);
  });
});

describe('buildStorageBreakdownBuckets', () => {
  it('folds unset sourceType into manual uploads and merges archived rows into the same bucket', () => {
    const buckets = buildStorageBreakdownBuckets([
      group({ sourceType: FabFileSourceType.MANUAL_UPLOAD, bytes: 10 }),
      group({ sourceType: null, bytes: 5, archived: true, fileCount: 2 }),
    ]);
    expect(buckets).toEqual([
      {
        key: 'manual_upload',
        sourceType: FabFileSourceType.MANUAL_UPLOAD,
        bytes: 15,
        fileCount: 3,
        archivedBytes: 5,
        archivedFileCount: 2,
      },
    ]);
  });

  it('splits lake sources per lake, keeps lake-less rows apart, and splits generated files by kind', () => {
    const buckets = buildStorageBreakdownBuckets([
      group({ sourceType: FabFileSourceType.GOOGLE_DRIVE, sourceLakeId: 'a', bytes: 3 }),
      group({ sourceType: FabFileSourceType.GOOGLE_DRIVE, sourceLakeId: 'b', bytes: 2 }),
      group({ sourceType: FabFileSourceType.GOOGLE_DRIVE, bytes: 1 }),
      group({ sourceType: FabFileSourceType.TOOL_GENERATED, mimeType: 'audio/mpeg', bytes: 4 }),
      group({ sourceType: FabFileSourceType.TOOL_GENERATED, mimeType: 'audio/wav', bytes: 4 }),
    ]);
    expect(buckets.map(b => [b.key, b.bytes, b.lakeId, b.mediaKind])).toEqual([
      ['tool_generated:audio', 8, undefined, 'audio'],
      ['google_drive:a', 3, 'a', undefined],
      ['google_drive:b', 2, 'b', undefined],
      ['google_drive', 1, undefined, undefined],
    ]);
  });
});
