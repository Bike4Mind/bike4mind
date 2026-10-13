import { describe, it, expect, vi } from 'vitest';
import type { FabFileNotice, FabFileNoticeBand } from '@bike4mind/utils';
import { scrubMissingKnowledgeIds } from './scrubMissingKnowledgeIds';

const GONE = '507f1f77bcf86cd799439001';
const LIVE = '507f1f77bcf86cd799439002';
const OTHER = '507f1f77bcf86cd799439003';

const logger = { info: vi.fn(), warn: vi.fn() } as never;

const notice = (over: Partial<FabFileNotice> = {}): FabFileNotice => ({
  fabFileId: GONE,
  fileName: 'ghost.pdf',
  band: 'unresolved',
  message: 'not found',
  delivered: false,
  ...over,
});

/**
 * `existing` is the set of ids that still have a row AT ALL - soft-deleted included, matching the
 * soft-delete-blind probe gate 2 uses. Everything else reads as hard-gone.
 */
const makeAdapters = (existing: string[] = []) => {
  const fabFiles = {
    findExistingIdsIncludingDeletedByIds: vi.fn(async (ids: string[]) => ids.filter(id => existing.includes(id))),
  };
  const sessions = { pullKnowledgeIds: vi.fn(async () => 1) };
  return { db: { fabFiles, sessions }, logger, fabFiles, sessions };
};

describe('scrubMissingKnowledgeIds', () => {
  it('detaches an unresolved id whose row is confirmed gone', async () => {
    const a = makeAdapters([]);
    const removed = await scrubMissingKnowledgeIds([GONE, LIVE], [notice()], a);

    expect(removed).toEqual([GONE]);
    expect(a.sessions.pullKnowledgeIds).toHaveBeenCalledWith([GONE]);
  });

  it('keeps an unresolved id whose row is only soft-deleted - a lake teardown is reversible', async () => {
    // A deleted lake soft-deletes its members and restoreDeletedDataLake revives them. A prompt sent
    // in that window must not pull the id out of every notebook fleet-wide, or the restore brings the
    // files back with nothing pointing at them. The filtered probe would report this row absent.
    const a = makeAdapters([GONE]);
    const removed = await scrubMissingKnowledgeIds([GONE], [notice()], a);

    expect(removed).toEqual([]);
    expect(a.sessions.pullKnowledgeIds).not.toHaveBeenCalled();
    expect(a.fabFiles.findExistingIdsIncludingDeletedByIds).toHaveBeenCalledWith([GONE]);
  });

  it('keeps an unresolved id whose row still exists - access loss is not deletion', async () => {
    // A revoked share, a lapsed lake grant, or a failed lake-access lookup all drop an id from the
    // turn while the document is intact. Detaching on that would be unrecoverable for the owner.
    const a = makeAdapters([GONE]);
    const removed = await scrubMissingKnowledgeIds([GONE], [notice()], a);

    expect(removed).toEqual([]);
    expect(a.sessions.pullKnowledgeIds).not.toHaveBeenCalled();
  });

  // The regression this helper exists to prevent. Every one of these bands is a LIVE file that
  // simply put no content in this turn's prompt, and an earlier draft that keyed off the turn's
  // raw droppedIds would have permanently detached all of them.
  const liveButUndelivered: FabFileNoticeBand[] = [
    'audio',
    'vision_unsupported',
    'image_not_serveable',
    'image_too_large',
    'unsupported_backend',
    'unsupported_type',
    'read_failed',
    'no_readable_content',
    'truncated',
  ];

  it.each(liveButUndelivered)('never detaches a file dropped with band %s', async band => {
    const a = makeAdapters([]);
    const removed = await scrubMissingKnowledgeIds([GONE], [notice({ band })], a);

    expect(removed).toEqual([]);
    expect(a.sessions.pullKnowledgeIds).not.toHaveBeenCalled();
    // Gate 1 rejects it outright, so the existence probe is never even reached.
    expect(a.fabFiles.findExistingIdsIncludingDeletedByIds).not.toHaveBeenCalled();
  });

  it('ignores an unresolved id the session does not pin', async () => {
    // A message-scoped or system-file attachment can be unresolved too; it is not the notebook's.
    const a = makeAdapters([]);
    const removed = await scrubMissingKnowledgeIds([LIVE], [notice({ fabFileId: OTHER })], a);

    expect(removed).toEqual([]);
    expect(a.fabFiles.findExistingIdsIncludingDeletedByIds).not.toHaveBeenCalled();
  });

  it('separates the gone from the merely inaccessible in one pass', async () => {
    const a = makeAdapters([LIVE]);
    const removed = await scrubMissingKnowledgeIds(
      [GONE, LIVE],
      [notice({ fabFileId: GONE }), notice({ fabFileId: LIVE })],
      a
    );

    expect(removed).toEqual([GONE]);
    expect(a.sessions.pullKnowledgeIds).toHaveBeenCalledWith([GONE]);
  });

  it('dedupes repeated notices for the same id', async () => {
    const a = makeAdapters([]);
    await scrubMissingKnowledgeIds([GONE], [notice(), notice()], a);

    expect(a.fabFiles.findExistingIdsIncludingDeletedByIds).toHaveBeenCalledWith([GONE]);
    expect(a.sessions.pullKnowledgeIds).toHaveBeenCalledWith([GONE]);
  });

  it('does nothing when the session pins no knowledge', async () => {
    const a = makeAdapters([]);
    expect(await scrubMissingKnowledgeIds([], [notice()], a)).toEqual([]);
    expect(a.fabFiles.findExistingIdsIncludingDeletedByIds).not.toHaveBeenCalled();
  });

  it('does nothing when the turn produced no notices', async () => {
    const a = makeAdapters([]);
    expect(await scrubMissingKnowledgeIds([GONE], [], a)).toEqual([]);
    expect(a.fabFiles.findExistingIdsIncludingDeletedByIds).not.toHaveBeenCalled();
  });

  it('swallows a lookup failure rather than taking the turn down with it', async () => {
    const a = makeAdapters([]);
    a.fabFiles.findExistingIdsIncludingDeletedByIds.mockRejectedValueOnce(new Error('mongo down'));

    expect(await scrubMissingKnowledgeIds([GONE], [notice()], a)).toEqual([]);
    expect(a.sessions.pullKnowledgeIds).not.toHaveBeenCalled();
  });

  it('swallows a write failure and reports nothing removed', async () => {
    const a = makeAdapters([]);
    a.sessions.pullKnowledgeIds.mockRejectedValueOnce(new Error('write failed'));

    expect(await scrubMissingKnowledgeIds([GONE], [notice()], a)).toEqual([]);
  });
});
