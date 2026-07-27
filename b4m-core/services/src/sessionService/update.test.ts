import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';

// Mock only `getCachedSignedUrl` from `@bike4mind/utils`; everything else (NotFoundError,
// secureParameters, etc.) stays real so `updateSession`'s validation/lookup logic still runs.
vi.mock('@bike4mind/utils', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/utils')>('@bike4mind/utils');
  return {
    ...actual,
    getCachedSignedUrl: vi.fn().mockResolvedValue('https://signed.example/fake-url'),
  };
});

vi.mock('../projectService', () => ({
  updateShareableFiles: vi.fn().mockResolvedValue(undefined),
}));

import { updateSession } from './update';
import { getCachedSignedUrl } from '@bike4mind/utils';
import { updateShareableFiles } from '../projectService';
import { IUserDocument } from '@bike4mind/common';

describe('updateSession — signed-URL cache pre-warm gate', () => {
  const user = { id: 'user-1' } as IUserDocument;

  const makeAdapters = (files: Array<Record<string, unknown>>) => ({
    db: {
      sessions: {
        shareable: {
          findUpdateAccessById: vi.fn().mockResolvedValue({
            id: 'session-1',
            knowledgeIds: [],
            artifactIds: [],
            tags: [],
            name: 'Session',
          }),
        },
        update: vi.fn(),
      },
      projects: {
        // Empty so the per-project `updateShareableFiles` loop is a no-op; this test only
        // exercises the cache pre-warm step above it.
        findAllBySessionId: vi.fn().mockResolvedValue([]),
      },
      fabFiles: {
        findAllByIds: vi.fn().mockResolvedValue(files),
      },
      caches: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape for this unit test
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- storage isn't exercised; getCachedSignedUrl is mocked above
    storage: {} as any,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips pre-warming the cache for pending/blocked/not-yet-cleared files but warms clean images and clean non-images', async () => {
    const files = [
      { id: 'f-clean', filePath: 'path/clean.png', mimeType: 'image/png', moderationStatus: 'clean' },
      { id: 'f-pending', filePath: 'path/pending.png', mimeType: 'image/png', moderationStatus: 'pending' },
      { id: 'f-blocked', filePath: 'path/blocked.png', mimeType: 'image/png', moderationStatus: 'blocked' },
      { id: 'f-undefined-status', filePath: 'path/mid-scan.png', mimeType: 'image/png' },
      { id: 'f-doc', filePath: 'path/doc.pdf', mimeType: 'application/pdf', moderationStatus: 'clean' },
      // isImageServeable gates on moderationStatus alone (no mimeType special-case):
      // a non-image with an unset moderationStatus is held exactly like an image, since
      // the declared mimeType is client-controlled and only corrected by the async
      // S3-event scan.
      { id: 'f-doc-unset-status', filePath: 'path/mid-scan.pdf', mimeType: 'application/pdf' },
    ];
    const adapters = makeAdapters(files);

    await updateSession(
      user,
      {
        id: 'session-1',
        knowledgeIds: ['f-clean', 'f-pending', 'f-blocked', 'f-undefined-status', 'f-doc', 'f-doc-unset-status'],
      },
      adapters
    );

    const cachedPaths = (getCachedSignedUrl as Mock).mock.calls.map(call => call[0]);
    expect(cachedPaths.sort()).toEqual(['path/clean.png', 'path/doc.pdf']);
  });
});

describe('updateSession - project propagation opt-out', () => {
  const user = { id: 'user-1' } as IUserDocument;

  const makeAdapters = () => {
    const project = { id: 'project-1', fileIds: ['already-there'] };
    return {
      project,
      adapters: {
        db: {
          sessions: {
            shareable: {
              findUpdateAccessById: vi.fn().mockResolvedValue({
                id: 'session-1',
                knowledgeIds: [],
                artifactIds: [],
                tags: [],
                name: 'Session',
              }),
            },
            update: vi.fn(),
          },
          projects: {
            findAllBySessionId: vi.fn().mockResolvedValue([project]),
            update: vi.fn(),
          },
          fabFiles: {
            findAllByIds: vi
              .fn()
              .mockResolvedValue([
                { id: 'new-file', filePath: 'p/new.pdf', mimeType: 'application/pdf', moderationStatus: 'clean' },
              ]),
          },
          caches: {},
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape for this unit test
        } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- storage isn't exercised; getCachedSignedUrl is mocked above
        storage: {} as any,
      },
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends the file to containing projects by default, preserving the pre-flag behaviour', async () => {
    const { project, adapters } = makeAdapters();

    await updateSession(user, { id: 'session-1', knowledgeIds: ['new-file'] }, adapters);

    expect(project.fileIds).toEqual(['already-there', 'new-file']);
    expect(adapters.db.projects.update).toHaveBeenCalledOnce();
    expect(updateShareableFiles).toHaveBeenCalledOnce();
  });

  it('does NOT touch projects when propagateToProjects is false', async () => {
    // The guard this locks: an upload that lands in notebook context by DEFAULT has
    // consented to this notebook, not to every notebook in the project and not to the
    // project's members. Propagation is append-only, so a wrong propagate is permanent.
    // Deleting the `propagateToProjects !== false` check makes this test fail.
    const { project, adapters } = makeAdapters();

    await updateSession(user, { id: 'session-1', knowledgeIds: ['new-file'], propagateToProjects: false }, adapters);

    expect(project.fileIds).toEqual(['already-there']);
    expect(adapters.db.projects.update).not.toHaveBeenCalled();
    expect(updateShareableFiles).not.toHaveBeenCalled();
    // The session itself still records the file - only the project fan-out is skipped.
    expect(adapters.db.sessions.update).toHaveBeenCalledOnce();
    expect(adapters.db.sessions.update.mock.calls[0][0].knowledgeIds).toEqual(['new-file']);
  });

  it('propagates when propagateToProjects is explicitly true', async () => {
    const { project, adapters } = makeAdapters();

    await updateSession(user, { id: 'session-1', knowledgeIds: ['new-file'], propagateToProjects: true }, adapters);

    expect(project.fileIds).toEqual(['already-there', 'new-file']);
    expect(adapters.db.projects.update).toHaveBeenCalledOnce();
  });

  it('skips propagation when knowledgeIds are unchanged, regardless of the flag', async () => {
    const { project, adapters } = makeAdapters();
    adapters.db.sessions.shareable.findUpdateAccessById.mockResolvedValue({
      id: 'session-1',
      knowledgeIds: ['new-file'],
      artifactIds: [],
      tags: [],
      name: 'Session',
    });

    await updateSession(user, { id: 'session-1', knowledgeIds: ['new-file'] }, adapters);

    expect(project.fileIds).toEqual(['already-there']);
    expect(adapters.db.projects.update).not.toHaveBeenCalled();
  });
});
