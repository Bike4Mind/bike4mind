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
        shareable: { findAllAccessibleByIds: vi.fn().mockResolvedValue(files) },
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

describe('updateSession - forceKnowledgeRetrieval passthrough', () => {
  const user = { id: 'user-1' } as IUserDocument;

  const makeAdapters = (existing: Record<string, unknown>) => {
    const update = vi.fn();
    return {
      update,
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
                ...existing,
              }),
            },
            update,
          },
          projects: { findAllBySessionId: vi.fn().mockResolvedValue([]) },
          fabFiles: { findAllByIds: vi.fn().mockResolvedValue([]) },
          caches: {},
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape for this unit test
        } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- storage isn't exercised here
        storage: {} as any,
      },
    };
  };

  beforeEach(() => vi.clearAllMocks());

  it('persists forceKnowledgeRetrieval: true onto the session', async () => {
    const { update, adapters } = makeAdapters({ forceKnowledgeRetrieval: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the new schema field before types settle
    await updateSession(user, { id: 'session-1', forceKnowledgeRetrieval: true } as any, adapters);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({ forceKnowledgeRetrieval: true });
  });

  it('persists forceKnowledgeRetrieval: false (toggling off), not the old truthy value', async () => {
    const { update, adapters } = makeAdapters({ forceKnowledgeRetrieval: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the new schema field before types settle
    await updateSession(user, { id: 'session-1', forceKnowledgeRetrieval: false } as any, adapters);
    expect(update.mock.calls[0][0]).toMatchObject({ forceKnowledgeRetrieval: false });
  });

  it('leaves forceKnowledgeRetrieval untouched when the field is omitted', async () => {
    const { update, adapters } = makeAdapters({ forceKnowledgeRetrieval: true });
    await updateSession(user, { id: 'session-1', name: 'Renamed' }, adapters);
    expect(update.mock.calls[0][0]).toMatchObject({ forceKnowledgeRetrieval: true, name: 'Renamed' });
  });

  it('ignores surface even if a caller passes it (allow-list strips it; sidebar visibility preserved)', async () => {
    const { update, adapters } = makeAdapters({ surface: 'opti', forceKnowledgeRetrieval: false });
    await updateSession(
      user,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately passing a field the allow-list must strip
      { id: 'session-1', surface: 'datalake', forceKnowledgeRetrieval: true } as any,
      adapters
    );
    const saved = update.mock.calls[0][0];
    expect(saved.forceKnowledgeRetrieval).toBe(true);
    expect(saved.surface).toBe('opti'); // unchanged - never overwritten by the update
  });
});

describe('updateSession - project propagation opt-out', () => {
  const user = { id: 'user-1' } as IUserDocument;

  const DEFAULT_FILE = {
    id: 'new-file',
    filePath: 'p/new.pdf',
    mimeType: 'application/pdf',
    moderationStatus: 'clean',
  };

  const makeAdapters = (
    accessibleFiles: Array<Record<string, unknown>> = [DEFAULT_FILE],
    // What the UNCHECKED lookup would have returned. Deliberately allowed to differ:
    // if these two are mocked identically, removing the ACL check changes nothing and
    // the security test passes without its guard.
    unrestrictedFiles: Array<Record<string, unknown>> = accessibleFiles
  ) => {
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
            findAllByIds: vi.fn().mockResolvedValue(unrestrictedFiles),
            shareable: { findAllAccessibleByIds: vi.fn().mockResolvedValue(accessibleFiles) },
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

  it('propagates only the newly added file, not the whole list', async () => {
    // Regression: propagating the full list let the flag leak across writes. A file
    // added earlier with propagation OFF would be pushed into the project by the next
    // write that had it ON - e.g. promoting one file publishing an unrelated one.
    const { project, adapters } = makeAdapters();
    adapters.db.sessions.shareable.findUpdateAccessById.mockResolvedValue({
      id: 'session-1',
      knowledgeIds: ['kept-private'],
      artifactIds: [],
      tags: [],
      name: 'Session',
    });

    await updateSession(user, { id: 'session-1', knowledgeIds: ['kept-private', 'new-file'] }, adapters);

    expect(project.fileIds).toEqual(['already-there', 'new-file']);
    expect(project.fileIds).not.toContain('kept-private');
  });

  it('does not touch projects when a write only REMOVES files', async () => {
    const { project, adapters } = makeAdapters();
    adapters.db.sessions.shareable.findUpdateAccessById.mockResolvedValue({
      id: 'session-1',
      knowledgeIds: ['a', 'b'],
      artifactIds: [],
      tags: [],
      name: 'Session',
    });

    await updateSession(user, { id: 'session-1', knowledgeIds: ['a'] }, adapters);

    expect(project.fileIds).toEqual(['already-there']);
    expect(adapters.db.projects.update).not.toHaveBeenCalled();
  });

  it('does not share a file the user cannot access', async () => {
    // updateShareableFiles grants every project member read+update on whatever it is
    // handed. Resolving ids without an ACL let a caller PUT someone else's fileId into
    // their own session and hand it to their project. Inaccessible ids are dropped.
    const victimFile = {
      id: 'someone-elses-file',
      filePath: 'p/victim.pdf',
      mimeType: 'application/pdf',
      moderationStatus: 'clean',
    };
    // Accessible: nothing. Unchecked lookup: the victim's file. Dropping the ACL check
    // makes the service see the victim file and share it - which is the failure.
    const { project, adapters } = makeAdapters([], [victimFile]);

    await updateSession(user, { id: 'session-1', knowledgeIds: ['someone-elses-file'] }, adapters);

    expect(project.fileIds).toEqual(['already-there']);
    expect(updateShareableFiles).not.toHaveBeenCalled();
    // The session itself still records it; only the project grant is refused.
    expect(adapters.db.sessions.update).toHaveBeenCalledOnce();
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
