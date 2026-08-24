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

// ObjectId-shaped: updateSession drops knowledgeIds that cannot address a row, and the lake
// derivation reads them through `_id: { $in: ... }`.
const LAKE_FILE_ID = '507f1f77bcf86cd799439001';
const PERSONAL_FILE_ID = '507f1f77bcf86cd799439002';

// knowledgeIds address the ObjectId-keyed FabFile._id, and updateSession now rejects anything
// that is not 24-hex, so these fixtures carry real ObjectId-shaped ids. The names are what the
// assertions read; the digits themselves are arbitrary.
const F_CLEAN = '000000000000000000000001';
const F_PENDING = '000000000000000000000002';
const F_BLOCKED = '000000000000000000000003';
const F_UNDEFINED_STATUS = '000000000000000000000004';
const F_DOC = '000000000000000000000005';
const F_DOC_UNSET_STATUS = '000000000000000000000006';
const NEW_FILE = '000000000000000000000007';
const KEPT_PRIVATE = '000000000000000000000008';
const FILE_A = '000000000000000000000009';
const FILE_B = '00000000000000000000000a';
const OTHERS_FILE = '00000000000000000000000b';

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
      { id: F_CLEAN, filePath: 'path/clean.png', mimeType: 'image/png', moderationStatus: 'clean' },
      { id: F_PENDING, filePath: 'path/pending.png', mimeType: 'image/png', moderationStatus: 'pending' },
      { id: F_BLOCKED, filePath: 'path/blocked.png', mimeType: 'image/png', moderationStatus: 'blocked' },
      { id: F_UNDEFINED_STATUS, filePath: 'path/mid-scan.png', mimeType: 'image/png' },
      { id: F_DOC, filePath: 'path/doc.pdf', mimeType: 'application/pdf', moderationStatus: 'clean' },
      // isImageServeable gates on moderationStatus alone (no mimeType special-case):
      // a non-image with an unset moderationStatus is held exactly like an image, since
      // the declared mimeType is client-controlled and only corrected by the async
      // S3-event scan.
      { id: F_DOC_UNSET_STATUS, filePath: 'path/mid-scan.pdf', mimeType: 'application/pdf' },
    ];
    const adapters = makeAdapters(files);

    await updateSession(
      user,
      {
        id: 'session-1',
        knowledgeIds: [F_CLEAN, F_PENDING, F_BLOCKED, F_UNDEFINED_STATUS, F_DOC, F_DOC_UNSET_STATUS],
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
    id: NEW_FILE,
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

    await updateSession(user, { id: 'session-1', knowledgeIds: [NEW_FILE] }, adapters);

    expect(project.fileIds).toEqual(['already-there', NEW_FILE]);
    expect(adapters.db.projects.update).toHaveBeenCalledOnce();
    expect(updateShareableFiles).toHaveBeenCalledOnce();
  });

  it('does NOT touch projects when propagateToProjects is false', async () => {
    // The guard this locks: an upload that lands in notebook context by DEFAULT has
    // consented to this notebook, not to every notebook in the project and not to the
    // project's members. Propagation is append-only, so a wrong propagate is permanent.
    // Deleting the `propagateToProjects !== false` check makes this test fail.
    const { project, adapters } = makeAdapters();

    await updateSession(user, { id: 'session-1', knowledgeIds: [NEW_FILE], propagateToProjects: false }, adapters);

    expect(project.fileIds).toEqual(['already-there']);
    expect(adapters.db.projects.update).not.toHaveBeenCalled();
    expect(updateShareableFiles).not.toHaveBeenCalled();
    // The session itself still records the file - only the project fan-out is skipped.
    expect(adapters.db.sessions.update).toHaveBeenCalledOnce();
    expect(adapters.db.sessions.update.mock.calls[0][0].knowledgeIds).toEqual([NEW_FILE]);
  });

  it('propagates only the newly added file, not the whole list', async () => {
    // Regression: propagating the full list let the flag leak across writes. A file
    // added earlier with propagation OFF would be pushed into the project by the next
    // write that had it ON - e.g. promoting one file publishing an unrelated one.
    const { project, adapters } = makeAdapters();
    adapters.db.sessions.shareable.findUpdateAccessById.mockResolvedValue({
      id: 'session-1',
      knowledgeIds: [KEPT_PRIVATE],
      artifactIds: [],
      tags: [],
      name: 'Session',
    });

    await updateSession(user, { id: 'session-1', knowledgeIds: [KEPT_PRIVATE, NEW_FILE] }, adapters);

    expect(project.fileIds).toEqual(['already-there', NEW_FILE]);
    expect(project.fileIds).not.toContain(KEPT_PRIVATE);
  });

  it('does not touch projects when a write only REMOVES files', async () => {
    const { project, adapters } = makeAdapters();
    adapters.db.sessions.shareable.findUpdateAccessById.mockResolvedValue({
      id: 'session-1',
      knowledgeIds: [FILE_A, FILE_B],
      artifactIds: [],
      tags: [],
      name: 'Session',
    });

    await updateSession(user, { id: 'session-1', knowledgeIds: [FILE_A] }, adapters);

    expect(project.fileIds).toEqual(['already-there']);
    expect(adapters.db.projects.update).not.toHaveBeenCalled();
  });

  it('does not share a file the user cannot access', async () => {
    // updateShareableFiles grants every project member read+update on whatever it is
    // handed. Resolving ids without an ACL let a caller PUT someone else's fileId into
    // their own session and hand it to their project. Inaccessible ids are dropped.
    const victimFile = {
      id: OTHERS_FILE,
      filePath: 'p/victim.pdf',
      mimeType: 'application/pdf',
      moderationStatus: 'clean',
    };
    // Accessible: nothing. Unchecked lookup: the victim's file. Dropping the ACL check
    // makes the service see the victim file and share it - which is the failure.
    const { project, adapters } = makeAdapters([], [victimFile]);

    await updateSession(user, { id: 'session-1', knowledgeIds: [OTHERS_FILE] }, adapters);

    expect(project.fileIds).toEqual(['already-there']);
    expect(updateShareableFiles).not.toHaveBeenCalled();
    // The session itself still records it; only the project grant is refused.
    expect(adapters.db.sessions.update).toHaveBeenCalledOnce();
  });

  it('propagates when propagateToProjects is explicitly true', async () => {
    const { project, adapters } = makeAdapters();

    await updateSession(user, { id: 'session-1', knowledgeIds: [NEW_FILE], propagateToProjects: true }, adapters);

    expect(project.fileIds).toEqual(['already-there', NEW_FILE]);
    expect(adapters.db.projects.update).toHaveBeenCalledOnce();
  });

  it('skips propagation when knowledgeIds are unchanged, regardless of the flag', async () => {
    const { project, adapters } = makeAdapters();
    adapters.db.sessions.shareable.findUpdateAccessById.mockResolvedValue({
      id: 'session-1',
      knowledgeIds: [NEW_FILE],
      artifactIds: [],
      tags: [],
      name: 'Session',
    });

    await updateSession(user, { id: 'session-1', knowledgeIds: [NEW_FILE] }, adapters);

    expect(project.fileIds).toEqual(['already-there']);
    expect(adapters.db.projects.update).not.toHaveBeenCalled();
  });

  describe('unusable knowledge ids', () => {
    /**
     * The rename and tag paths PUT the whole session (`{ ...session, name }`), so a legacy entry
     * rides along on a write that has nothing to do with knowledge. Rejecting it would make such a
     * notebook impossible to rename; dropping it heals the row instead.
     */
    it('drops an unusable knowledgeId and still performs the write', async () => {
      const { adapters } = makeAdapters();
      await updateSession(
        user,
        { id: 'session-1', name: 'renamed', knowledgeIds: ['legacy-uuid', NEW_FILE] },
        adapters
      );

      const written = adapters.db.sessions.update.mock.calls[0][0];
      expect(written.knowledgeIds).toEqual([NEW_FILE]);
      expect(written.name).toBe('renamed');
    });

    it('preserves the stored list when the field is absent, rather than filtering it to empty', async () => {
      const { adapters } = makeAdapters();
      await updateSession(user, { id: 'session-1', name: 'renamed' }, adapters);

      // The fixture session carries [], so this pins "unchanged", not "cleared".
      expect(adapters.db.sessions.update.mock.calls[0][0].knowledgeIds).toEqual([]);
    });
  });
});

/**
 * Attaching a lake file to an already-open notebook is the most ordinary way a user reaches a lake,
 * and it goes through update() - which derived nothing, so the session stayed unscoped and retrieval
 * fell through to every lake the caller could reach. An empty retrievalTags is NOT a narrow scope.
 */
describe('updateSession - lake-scope derivation on attach', () => {
  const user = { id: 'user-1' } as IUserDocument;

  const makeAdapters = (existing: Record<string, unknown>, lakeFiles: Array<Record<string, unknown>>) => {
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
          fabFiles: {
            findAllByIds: vi.fn().mockResolvedValue([]),
            shareable: { findAllAccessibleByIds: vi.fn().mockResolvedValue(lakeFiles) },
          },
          caches: {},
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape
        } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- storage isn't exercised here
        storage: {} as any,
      },
    };
  };

  beforeEach(() => vi.clearAllMocks());

  it('derives the lake tag when a lake file is attached to an open session', async () => {
    const { update, adapters } = makeAdapters({}, [{ id: LAKE_FILE_ID, tags: [{ name: 'datalake:acme' }] }]);

    await updateSession(user, { id: 'session-1', knowledgeIds: [LAKE_FILE_ID] } as never, adapters as never);

    expect(update.mock.calls[0][0]).toMatchObject({ retrievalTags: ['datalake:acme'] });
  });

  it('derives nothing from a personal file, leaving the notebook unscoped', async () => {
    const { update, adapters } = makeAdapters({}, [{ id: PERSONAL_FILE_ID, tags: [{ name: 'notes' }] }]);

    await updateSession(user, { id: 'session-1', knowledgeIds: [PERSONAL_FILE_ID] } as never, adapters as never);

    expect(update.mock.calls[0][0].retrievalTags).toBeUndefined();
  });

  it('never overwrites a scope the session already has', async () => {
    const { update, adapters } = makeAdapters({ retrievalTags: ['datalake:chosen'] }, [
      { id: LAKE_FILE_ID, tags: [{ name: 'datalake:acme' }] },
    ]);

    await updateSession(user, { id: 'session-1', knowledgeIds: [LAKE_FILE_ID] } as never, adapters as never);

    expect(update.mock.calls[0][0]).toMatchObject({ retrievalTags: ['datalake:chosen'] });
  });
});
