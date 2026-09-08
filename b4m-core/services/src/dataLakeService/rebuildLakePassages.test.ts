import { describe, it, expect, vi } from 'vitest';
import { OVERSIZED_PASSAGE_TOKEN_THRESHOLD } from '@bike4mind/common';
import { detectUnderChunkedFiles, countFailedLakeFiles } from './rebuildLakePassages';

const lake = { datalakeTag: 'datalake:acme', fileTagPrefix: 'acme:', createdByUserId: 'owner-1' };

const makeDeps = (
  files: { id: string; userId: string }[],
  underChunkedIds: string[],
  stranded: { id: string; userId: string }[] = []
) => ({
  db: {
    fabFiles: {
      findChunkedFilesByScope: vi.fn().mockResolvedValue(files),
      findConvergencePausedFilesByScope: vi.fn().mockResolvedValue(stranded),
    },
    fabFileChunks: { findUnderChunkedFabFileIds: vi.fn().mockResolvedValue(underChunkedIds) },
  },
});

describe('detectUnderChunkedFiles', () => {
  it('returns empty (and never queries chunks) when the lake has no chunked files', async () => {
    const deps = makeDeps([], []);
    const result = await detectUnderChunkedFiles(lake, deps);
    expect(result).toEqual([]);
    expect(deps.db.fabFileChunks.findUnderChunkedFabFileIds).not.toHaveBeenCalled();
  });

  it('keeps only the under-chunked files and pairs each with its owner userId', async () => {
    const files = [
      { id: 'f1', userId: 'owner-1' },
      { id: 'f2', userId: 'owner-2' },
      { id: 'f3', userId: 'owner-1' },
    ];
    // f2, f1 are oversized (f3 is fine); order is worst-first as the repo returns it.
    const deps = makeDeps(files, ['f2', 'f1']);
    const result = await detectUnderChunkedFiles(lake, deps);
    expect(result).toEqual([
      { fabFileId: 'f2', userId: 'owner-2' },
      { fabFileId: 'f1', userId: 'owner-1' },
    ]);
  });

  it('preserves the repo worst-first ordering (does not re-sort)', async () => {
    const files = [
      { id: 'a', userId: 'u' },
      { id: 'b', userId: 'u' },
      { id: 'c', userId: 'u' },
    ];
    const deps = makeDeps(files, ['c', 'a', 'b']);
    const result = await detectUnderChunkedFiles(lake, deps);
    expect(result.map(r => r.fabFileId)).toEqual(['c', 'a', 'b']);
  });

  it('includes convergence-stranded members even when the lake has no chunked files at all', async () => {
    // The reported blind spot: passages deleted by a halted wave leave chunked:false + error:null, so
    // both the chunked read and the failed-count read return nothing and the button hid itself.
    const deps = makeDeps([], [], [{ id: 'stranded-1', userId: 'owner-9' }]);
    const result = await detectUnderChunkedFiles(lake, deps);
    expect(result).toEqual([{ fabFileId: 'stranded-1', userId: 'owner-9' }]);
    expect(deps.db.fabFileChunks.findUnderChunkedFabFileIds).not.toHaveBeenCalled();
  });

  it('leads with stranded members, ahead of any under-chunked overshoot', async () => {
    const deps = makeDeps([{ id: 'f1', userId: 'u' }], ['f1'], [{ id: 'stranded-1', userId: 'owner-9' }]);
    const result = await detectUnderChunkedFiles(lake, deps);
    expect(result.map(r => r.fabFileId)).toEqual(['stranded-1', 'f1']);
  });

  // The two reads CAN overlap now that stranded covers the vectorize arm: such a file is
  // `chunked:true`, so findChunkedFilesByScope returns it, and one of its chunks can also be
  // oversized. One entry per file, because the caller enqueues one chunk job per entry and the count
  // is rendered to the owner as a file count.
  it('reports a file that is BOTH stranded and under-chunked exactly once', async () => {
    const deps = makeDeps([{ id: 'f1', userId: 'u' }], ['f1'], [{ id: 'f1', userId: 'u' }]);
    const result = await detectUnderChunkedFiles(lake, deps);
    expect(result).toEqual([{ fabFileId: 'f1', userId: 'u' }]);
  });

  it('passes the lake file ids and the default threshold to the chunk query', async () => {
    const files = [
      { id: 'f1', userId: 'u' },
      { id: 'f2', userId: 'u' },
    ];
    const deps = makeDeps(files, []);
    await detectUnderChunkedFiles(lake, deps);
    expect(deps.db.fabFileChunks.findUnderChunkedFabFileIds).toHaveBeenCalledWith(
      ['f1', 'f2'],
      OVERSIZED_PASSAGE_TOKEN_THRESHOLD
    );
  });

  it('forwards an explicit threshold override', async () => {
    const deps = makeDeps([{ id: 'f1', userId: 'u' }], []);
    await detectUnderChunkedFiles(lake, deps, 4096);
    expect(deps.db.fabFileChunks.findUnderChunkedFabFileIds).toHaveBeenCalledWith(['f1'], 4096);
  });

  it('drops an id the chunk query returns that is not in the file set (defensive, never expected)', async () => {
    const deps = makeDeps([{ id: 'f1', userId: 'owner-1' }], ['f1', 'ghost']);
    const result = await detectUnderChunkedFiles(lake, deps);
    expect(result).toEqual([{ fabFileId: 'f1', userId: 'owner-1' }]);
  });
});

describe('countFailedLakeFiles', () => {
  it('delegates to the repo with the lake membership scope and returns the count', async () => {
    const countFailedFilesByScope = vi.fn().mockResolvedValue(3);
    const result = await countFailedLakeFiles(lake, { db: { fabFiles: { countFailedFilesByScope } } });
    expect(result).toBe(3);
    expect(countFailedFilesByScope).toHaveBeenCalledWith({
      kind: 'owned',
      datalakeTag: 'datalake:acme',
      fileTagPrefix: 'acme:',
      creatorUserId: 'owner-1',
    });
  });
});
