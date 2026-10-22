import { describe, it, expect, vi } from 'vitest';
import type { FabFileNotice } from '@bike4mind/utils';
import { classifyUnresolvedFileIds } from './classifyUnresolvedFileIds';

const GONE = '507f1f77bcf86cd799439001';
const DELETED = '507f1f77bcf86cd799439002';
const LIVE = '507f1f77bcf86cd799439003';

const unresolved = (fabFileId: string): FabFileNotice => ({
  fabFileId,
  fileName: fabFileId,
  band: 'unresolved',
  message: 'not found',
  delivered: false,
});

// `anyRow` = every row including soft-deleted; `liveRow` = only rows without deletedAt set.
const fabFiles = (anyRow: string[], liveRow: string[]) => ({
  findExistingIdsIncludingDeletedByIds: vi.fn(async () => anyRow),
  findExistingIdsByIds: vi.fn(async () => liveRow),
});

describe('classifyUnresolvedFileIds', () => {
  it('splits unresolved ids into gone, soft-deleted and live', async () => {
    const result = await classifyUnresolvedFileIds(
      [GONE, DELETED, LIVE],
      [unresolved(GONE), unresolved(DELETED), unresolved(LIVE)],
      fabFiles([DELETED, LIVE], [LIVE])
    );

    expect(result).toEqual({ gone: [GONE], softDeleted: [DELETED] });
  });

  it('ignores notices from every other band, and ids the turn did not reference', async () => {
    const files = fabFiles([], []);
    const result = await classifyUnresolvedFileIds(
      [LIVE],
      [{ ...unresolved(GONE), band: 'audio' }, { ...unresolved(GONE), band: 'truncated' }, unresolved(GONE + 'x')],
      files
    );

    expect(result).toEqual({ gone: [], softDeleted: [] });
    expect(files.findExistingIdsIncludingDeletedByIds).not.toHaveBeenCalled();
  });

  it('asks once per distinct unresolved id the turn referenced', async () => {
    const files = fabFiles([], []);
    await classifyUnresolvedFileIds([GONE], [unresolved(GONE), unresolved(GONE)], files);

    expect(files.findExistingIdsIncludingDeletedByIds).toHaveBeenCalledWith([GONE]);
    expect(files.findExistingIdsByIds).toHaveBeenCalledWith([GONE]);
  });

  it('rejects when the live-row probe fails, so the caller leaves the reference alone', async () => {
    await expect(
      classifyUnresolvedFileIds([LIVE], [unresolved(LIVE)], {
        findExistingIdsIncludingDeletedByIds: vi.fn(async () => [LIVE]),
        findExistingIdsByIds: vi.fn(async () => Promise.reject(new Error('db down'))),
      })
    ).rejects.toThrow('db down');
  });
});
