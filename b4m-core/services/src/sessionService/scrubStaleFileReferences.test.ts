import { describe, it, expect, vi } from 'vitest';
import type { FabFileNotice } from '@bike4mind/utils';
import { scrubStaleProjectFiles, scrubStaleSystemFiles } from './scrubStaleFileReferences';

const GONE = '507f1f77bcf86cd799439001';
const DELETED = '507f1f77bcf86cd799439002';
const LIVE = '507f1f77bcf86cd799439003';
const USER = '507f1f77bcf86cd7994390bb';
const PROJECT = '507f1f77bcf86cd7994390cc';

const logger = { info: vi.fn(), warn: vi.fn() } as never;

const unresolved = (fabFileId: string): FabFileNotice => ({
  fabFileId,
  fileName: fabFileId,
  band: 'unresolved',
  message: 'not found',
  delivered: false,
});

// Read-only by construction: the fake exposes only the two existence probes, so any attempt to
// write to a file document would fail to compile and to run.
const fabFiles = () => ({
  findExistingIdsIncludingDeletedByIds: vi.fn(async (ids: string[]) => ids.filter(id => id !== GONE)),
  findExistingIdsByIds: vi.fn(async (ids: string[]) => ids.filter(id => id === LIVE)),
});

describe('scrubStaleSystemFiles', () => {
  it('removes system files whose file is gone or soft-deleted from the caller only', async () => {
    const users = { pullSystemFiles: vi.fn(async () => undefined) };
    const removed = await scrubStaleSystemFiles(
      USER,
      [GONE, DELETED, LIVE],
      [unresolved(GONE), unresolved(DELETED), unresolved(LIVE)],
      { db: { fabFiles: fabFiles(), users }, logger }
    );

    expect(removed).toEqual([GONE, DELETED]);
    expect(users.pullSystemFiles).toHaveBeenCalledWith(USER, [GONE, DELETED]);
  });

  it('keeps a system file whose file is live, even when this turn could not read it', async () => {
    const users = { pullSystemFiles: vi.fn(async () => undefined) };
    const removed = await scrubStaleSystemFiles(USER, [LIVE], [unresolved(LIVE)], {
      db: { fabFiles: fabFiles(), users },
      logger,
    });

    expect(removed).toEqual([]);
    expect(users.pullSystemFiles).not.toHaveBeenCalled();
  });

  it('ignores files that were delivered or dropped for a reason other than resolution', async () => {
    const users = { pullSystemFiles: vi.fn(async () => undefined) };
    const files = fabFiles();
    const removed = await scrubStaleSystemFiles(USER, [GONE], [{ ...unresolved(GONE), band: 'audio' }], {
      db: { fabFiles: files, users },
      logger,
    });

    expect(removed).toEqual([]);
    expect(files.findExistingIdsIncludingDeletedByIds).not.toHaveBeenCalled();
  });

  it('never throws when the write fails', async () => {
    const users = { pullSystemFiles: vi.fn(async () => Promise.reject(new Error('write failed'))) };
    await expect(
      scrubStaleSystemFiles(USER, [GONE], [unresolved(GONE)], { db: { fabFiles: fabFiles(), users }, logger })
    ).resolves.toEqual([]);
  });
});

describe('scrubStaleProjectFiles', () => {
  it('removes project files and system prompts whose file is gone or soft-deleted, in that project', async () => {
    const projects = { pullFileReferences: vi.fn(async () => undefined) };
    const removed = await scrubStaleProjectFiles(
      { id: PROJECT, fileIds: [GONE, LIVE], systemPrompts: [{ fileId: DELETED }] },
      [unresolved(GONE), unresolved(DELETED)],
      { db: { fabFiles: fabFiles(), projects }, logger }
    );

    expect(removed).toEqual([GONE, DELETED]);
    expect(projects.pullFileReferences).toHaveBeenCalledWith([GONE, DELETED], PROJECT);
  });

  it('keeps a project file that is live but unreadable by the collaborator whose turn this is', async () => {
    const projects = { pullFileReferences: vi.fn(async () => undefined) };
    const removed = await scrubStaleProjectFiles(
      { id: PROJECT, fileIds: [LIVE], systemPrompts: [] },
      [unresolved(LIVE)],
      {
        db: { fabFiles: fabFiles(), projects },
        logger,
      }
    );

    expect(removed).toEqual([]);
    expect(projects.pullFileReferences).not.toHaveBeenCalled();
  });

  it('ignores unresolved ids the project does not reference', async () => {
    // Project turns also resolve the project's notebooks' knowledge; those belong to the sessions.
    const projects = { pullFileReferences: vi.fn(async () => undefined) };
    const removed = await scrubStaleProjectFiles({ id: PROJECT, fileIds: [LIVE] }, [unresolved(GONE)], {
      db: { fabFiles: fabFiles(), projects },
      logger,
    });

    expect(removed).toEqual([]);
    expect(projects.pullFileReferences).not.toHaveBeenCalled();
  });
});
