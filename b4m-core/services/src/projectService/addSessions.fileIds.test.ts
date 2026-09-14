import { describe, it, expect, beforeEach, vi } from 'vitest';
import { addSessions } from './addSessions';
import {
  createMockProjectRepository,
  createMockSessionRepository,
  createMockFabFileRepository,
} from '../__tests__/utils/testUtils';
import type {
  IFabFileDocument,
  IFabFileRepository,
  IProjectDocument,
  IProjectRepository,
  ISessionDocument,
  ISessionRepository,
  IUserDocument,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/common';
import * as addFilesModule from './addFiles';

/**
 * Pins WHICH ids `addSessions` copies into `project.sessionIds` and `project.fileIds`. The larger
 * `addSessions.test.ts` suite is skipped, so without this the behaviour changes on this path are
 * untested. Both writes must persist what RESOLVED, never the raw list handed in.
 *
 * The set pushed is what `findAllByIds` RESOLVED, which is narrower than "the castable ids":
 * `softDeletePlugin` adds `deletedAt: null` to every `find`, so a soft-deleted row is missing
 * from the result too. Both exclusions are asserted below so a future change to either one is
 * a failing test rather than a silent change in what a project inherits.
 */

const USER_ID = 'user-1';
const PROJECT_ID = 'project-1';
// Hex, not 'session-1': sessions are ObjectId-keyed, and the two-hex-cases test below is
// only meaningful for an id Mongo actually resolves case-insensitively.
const SESSION_ID = '67dbe18a7f9cf1fa5d9686aa';

const LIVE_ID = '67dbe18a7f9cf1fa5d968600';
// Castable, but its row is soft-deleted, so findAllByIds does not return it.
const SOFT_DELETED_ID = '67dbe18a7f9cf1fa5d968601';
// Not castable at all: the shape a session row written before the id filtering can still hold.
const JUNK_ID = 'legacy-uuid-not-an-objectid';

let projects: IProjectRepository;
let sessions: ISessionRepository;
let fabFiles: IFabFileRepository;
let project: IProjectDocument;
let session: ISessionDocument;

const user = { id: USER_ID, groups: [] } as unknown as IUserDocument;

beforeEach(() => {
  projects = createMockProjectRepository();
  sessions = createMockSessionRepository();
  fabFiles = createMockFabFileRepository();

  vi.spyOn(addFilesModule, 'updateShareableFiles').mockResolvedValue(undefined as never);

  project = {
    id: PROJECT_ID,
    userId: USER_ID,
    sessionIds: [],
    fileIds: [],
    users: [],
  } as unknown as IProjectDocument;

  session = {
    id: SESSION_ID,
    userId: USER_ID,
    knowledgeIds: [JUNK_ID, LIVE_ID, SOFT_DELETED_ID],
    users: [],
  } as unknown as ISessionDocument;

  (sessions.shareable.findAllAccessibleByIds as ReturnType<typeof vi.fn>).mockResolvedValue([session]);
  (projects.shareable.findAccessibleById as ReturnType<typeof vi.fn>).mockResolvedValue(project);
  (sessions.update as ReturnType<typeof vi.fn>).mockResolvedValue(session);
  (projects.update as ReturnType<typeof vi.fn>).mockResolvedValue(project);
  // What the guarded repository actually returns: the junk id is dropped by usableObjectIds and
  // the soft-deleted row is dropped by softDeletePlugin, leaving only the live file.
  (fabFiles.findAllByIds as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: LIVE_ID } as unknown as IFabFileDocument,
  ]);
});

describe('addSessions - which ids reach the project', () => {
  it('copies the id that resolved to a row', async () => {
    await addSessions(user, { projectId: PROJECT_ID, sessionIds: [SESSION_ID] }, {
      db: { projects, sessions, fabFiles },
    } as never);

    expect(project.fileIds).toEqual([LIVE_ID]);
  });

  it('does not copy an id that cannot address a row, so it is not spread to the project', async () => {
    await addSessions(user, { projectId: PROJECT_ID, sessionIds: [SESSION_ID] }, {
      db: { projects, sessions, fabFiles },
    } as never);

    expect(project.fileIds).not.toContain(JUNK_ID);
  });

  it('also drops a castable id whose row did not come back, e.g. soft-deleted', async () => {
    // Documents a real divergence from the pre-guard behaviour, which copied the raw list: a file
    // soft-deleted while still listed in knowledgeIds no longer reappears in the project when it
    // is restored. Change this expectation only together with the push in updateShareableSessions.
    await addSessions(user, { projectId: PROJECT_ID, sessionIds: [SESSION_ID] }, {
      db: { projects, sessions, fabFiles },
    } as never);

    expect(project.fileIds).not.toContain(SOFT_DELETED_ID);
  });

  it('rejects a request whose session ids only partly resolved, persisting nothing', async () => {
    // findAllAccessibleByIds skips an uncastable id instead of throwing, so a partial resolve is
    // now reachable. Answering 200 with only the reachable notebook attached would give the
    // caller no signal that half its request was ignored.
    await expect(
      addSessions(user, { projectId: PROJECT_ID, sessionIds: [JUNK_ID, SESSION_ID] }, {
        db: { projects, sessions, fabFiles },
      } as never)
    ).rejects.toThrow(BadRequestError);

    expect(project.sessionIds).toEqual([]);
    expect(projects.update).not.toHaveBeenCalled();
  });

  it('tolerates the same session id twice, since a duplicate resolves one row', async () => {
    // Nothing dedupes the request: the zod tuple does not, and neither does the API route.
    await addSessions(user, { projectId: PROJECT_ID, sessionIds: [SESSION_ID, SESSION_ID] }, {
      db: { projects, sessions, fabFiles },
    } as never);

    expect(project.sessionIds).toEqual([SESSION_ID]);
  });

  it('tolerates the same session id sent in two hex cases, which address one row', async () => {
    // isObjectIdOrHexString accepts either case and Mongo resolves both to the same document, so
    // counting them as two distinct ids rejected a request that addresses exactly one notebook.
    await addSessions(user, { projectId: PROJECT_ID, sessionIds: [SESSION_ID, SESSION_ID.toUpperCase()] }, {
      db: { projects, sessions, fabFiles },
    } as never);

    expect(project.sessionIds).toEqual([SESSION_ID]);
  });

  it('queries the repository with the session raw list, leaving the filtering to the guard', async () => {
    await addSessions(user, { projectId: PROJECT_ID, sessionIds: [SESSION_ID] }, {
      db: { projects, sessions, fabFiles },
    } as never);

    expect(fabFiles.findAllByIds).toHaveBeenCalledWith([JUNK_ID, LIVE_ID, SOFT_DELETED_ID]);
  });
});
