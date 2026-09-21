import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock state via vi.hoisted so it is initialized before the hoisted vi.mock factories run.
const {
  sideEffects,
  createSessionService,
  projectGet,
  SessionModelMock,
  sessionSave,
  UserMock,
  userRepoUpdate,
  sessionRepoFindById,
  sessionRepoFindByIdAndUserId,
  accessibleBySpy,
  favoriteRepoFind,
  userRepoFindById,
  defineAbilitiesForSpy,
} = vi.hoisted(() => {
  const sessionSave = vi.fn().mockResolvedValue(undefined);
  // any: a Mongoose model mock that is both newable (regular function so it works with
  // `new`) and carries static query methods.
  const SessionModelMock: any = vi.fn(function (this: Record<string, unknown>, data: Record<string, unknown>) {
    Object.assign(this, data, { id: 'new-session-id', save: sessionSave });
  });
  SessionModelMock.findOne = vi.fn();
  SessionModelMock.find = vi.fn();
  SessionModelMock.findById = vi.fn();
  SessionModelMock.findOneAndUpdate = vi.fn();
  SessionModelMock.deleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 });

  const UserMock = {
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn().mockResolvedValue(undefined),
    updateOne: vi.fn().mockReturnValue({ session: vi.fn().mockResolvedValue(undefined) }),
  };

  return {
    sideEffects: {
      notifySessionCreated: vi.fn().mockResolvedValue(undefined),
      logSessionCreatedEvent: vi.fn().mockReturnValue(Promise.resolve()),
      logProjectSessionAddedEvent: vi.fn().mockReturnValue(Promise.resolve()),
      recordNotebookAddedToProjectActivity: vi.fn().mockReturnValue(Promise.resolve()),
    },
    createSessionService: vi.fn(),
    projectGet: vi.fn(),
    SessionModelMock,
    sessionSave,
    UserMock,
    userRepoUpdate: vi.fn().mockResolvedValue(undefined),
    sessionRepoFindById: vi.fn(),
    sessionRepoFindByIdAndUserId: vi.fn(),
    accessibleBySpy: vi.fn(() => ({ ofType: () => ({}) })),
    favoriteRepoFind: vi.fn(),
    userRepoFindById: vi.fn(),
    defineAbilitiesForSpy: vi.fn(),
  };
});

// ---- Side-effect boundary: spy on composition, not real implementations ----
vi.mock('./sessionSideEffects', () => sideEffects);

vi.mock('@bike4mind/services', () => ({
  sessionService: { createSession: createSessionService },
  projectService: { get: projectGet },
}));

vi.mock('@bike4mind/database', () => ({
  Session: SessionModelMock,
  User: UserMock,
  mongoose: { Types: { ObjectId: class {} } },
  compareMongoIds: (a: unknown, b: unknown) => String(a) === String(b),
  favoriteRepository: { find: favoriteRepoFind },
  fabFileRepository: {},
  projectRepository: {},
  agentRepository: {},
  userRepository: { update: userRepoUpdate, findById: userRepoFindById },
}));

vi.mock('@server/auth/ability', () => ({
  default: defineAbilitiesForSpy,
}));

vi.mock('@bike4mind/database/auth', () => ({
  // find is shared with SessionModelMock so tests can drive both bindings from one mock.
  Session: { modelName: 'Session', find: SessionModelMock.find },
  sessionRepository: {
    findById: sessionRepoFindById,
    findByIdAndUserId: sessionRepoFindByIdAndUserId,
    shareable: { findAllShared: vi.fn() },
  },
}));

vi.mock('@bike4mind/common', () => ({
  Permission: { create: 'create', read: 'read', update: 'update', delete: 'delete' },
  // @server/utils/errors re-exports NotFoundError from here, so it must be provided.
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: { log: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('@casl/mongoose', () => ({
  accessibleBy: accessibleBySpy,
}));

import { getOrCreateSession, createSession, getFavoriteSessionByUser } from './sessionCrud';
import {
  notifySessionCreated,
  logSessionCreatedEvent,
  logProjectSessionAddedEvent,
  recordNotebookAddedToProjectActivity,
} from './sessionSideEffects';
import type { IUserDocument } from '@bike4mind/common';
import type { Ability } from '@server/auth/ability';
import type { Logger } from '@bike4mind/observability';

// Typed casts keep the intended types visible (and catch drift) without a real Mongoose doc.
const mockAbility = (canResult: boolean): Ability =>
  ({ can: vi.fn().mockReturnValue(canResult) }) as unknown as Ability;

const logger = { log: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
const user = { id: 'user-1' } as unknown as IUserDocument;
const allowAbility = mockAbility(true);

describe('sessionCrud', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getOrCreateSession', () => {
    it('fetches an accessible existing session via an access-scoped lookup (owner/share/org)', async () => {
      SessionModelMock.findOne.mockResolvedValueOnce({ id: 'existing', name: 'Existing' });

      const result = await getOrCreateSession({ sessionId: 'existing', user, ability: allowAbility, logger });

      expect(result.wasCreated).toBe(false);
      expect(result.sessionId).toBe('existing');
      // access-scoped: filtered by _id AND accessibleBy(), never a bare findById
      expect(SessionModelMock.findOne).toHaveBeenCalledWith(expect.objectContaining({ _id: 'existing' }));
      expect(sessionRepoFindById).not.toHaveBeenCalled();
      expect(notifySessionCreated).not.toHaveBeenCalled();
      expect(logSessionCreatedEvent).not.toHaveBeenCalled();
    });

    it('scopes the lookup with the update verb, so a read-only share cannot continue the session', async () => {
      SessionModelMock.findOne.mockResolvedValueOnce({ id: 'existing', name: 'Existing' });

      await getOrCreateSession({ sessionId: 'existing', user, ability: allowAbility, logger });

      // Quests are appended to this session and the retry path clears an existing quest's reply,
      // so `read` here would let a read-only share mutate the owner's notebook.
      expect(accessibleBySpy).toHaveBeenCalledWith(allowAbility, 'update');
      expect(accessibleBySpy).not.toHaveBeenCalledWith(allowAbility, 'read');
    });

    it('throws NotFoundError when the caller has no access to the requested session (foreign session)', async () => {
      // accessibleBy() filters the doc out -> findOne resolves null (same 404 as truly missing,
      // so a caller cannot distinguish "not yours" from "does not exist")
      SessionModelMock.findOne.mockResolvedValueOnce(null);
      await expect(
        getOrCreateSession({ sessionId: 'someone-elses', user, ability: allowAbility, logger })
      ).rejects.toThrow('Session not found');
    });

    it('falls back to an owner-only lookup when no ability is supplied (e.g. the Slack path)', async () => {
      sessionRepoFindByIdAndUserId.mockResolvedValueOnce({ id: 'owned', name: 'Owned' });

      const result = await getOrCreateSession({ sessionId: 'owned', user, logger });

      expect(result.sessionId).toBe('owned');
      expect(sessionRepoFindByIdAndUserId).toHaveBeenCalledWith('owned', 'user-1');
      expect(sessionRepoFindById).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the owner-only fallback finds nothing', async () => {
      sessionRepoFindByIdAndUserId.mockResolvedValueOnce(null);
      await expect(getOrCreateSession({ sessionId: 'not-owned', user, logger })).rejects.toThrow('Session not found');
    });

    it('creates a session, notifies clients, and defers analytics + last-notebook update', async () => {
      const created = { id: 'sess-new', name: 'New Notebook' };
      createSessionService.mockResolvedValueOnce(created);

      const result = await getOrCreateSession({ sessionName: 'New Notebook', user, ability: allowAbility, logger });

      expect(result.wasCreated).toBe(true);
      expect(result.sessionId).toBe('sess-new');
      // WebSocket notification is awaited (composition, not inlined here)
      expect(notifySessionCreated).toHaveBeenCalledWith(created, 'user-1', logger);
      // analytics + last-notebook update are deferred via asyncPromises
      expect(logSessionCreatedEvent).toHaveBeenCalledWith('user-1', created, allowAbility);
      expect(userRepoUpdate).toHaveBeenCalledWith({ id: 'user-1', lastNotebookId: 'sess-new' });
      // no project -> project side effects untouched
      expect(logProjectSessionAddedEvent).not.toHaveBeenCalled();
      expect(recordNotebookAddedToProjectActivity).not.toHaveBeenCalled();
      // asyncPromises holds the deferred work (analytics + user update)
      expect(result.asyncPromises.length).toBeGreaterThanOrEqual(2);
      await Promise.all(result.asyncPromises);
    });

    it('also logs project add + activity when created within a project', async () => {
      const created = { id: 'sess-new', name: 'New Notebook' };
      createSessionService.mockResolvedValueOnce(created);
      projectGet.mockResolvedValueOnce({ name: 'My Project' });

      const result = await getOrCreateSession({ projectId: 'proj-1', user, ability: allowAbility, logger });

      expect(projectGet).toHaveBeenCalled();
      expect(logProjectSessionAddedEvent).toHaveBeenCalledWith(
        'user-1',
        'proj-1',
        'My Project',
        'sess-new',
        allowAbility
      );
      expect(recordNotebookAddedToProjectActivity).toHaveBeenCalledWith('proj-1', 'user-1');
      await Promise.all(result.asyncPromises);
    });
  });

  describe('createSession', () => {
    it('throws when the ability denies session creation', async () => {
      const denyAbility = mockAbility(false);
      await expect(createSession('user-1', { name: 'X' }, denyAbility)).rejects.toThrow('Cannot create session');
      expect(SessionModelMock).not.toHaveBeenCalled();
    });

    it('persists a new notebook and does not touch lastNotebook by default', async () => {
      const notebook = await createSession('user-1', { name: 'My NB' }, allowAbility);
      expect(SessionModelMock).toHaveBeenCalledTimes(1);
      expect(sessionSave).toHaveBeenCalledTimes(1);
      expect(notebook.id).toBe('new-session-id');
      expect(UserMock.updateOne).not.toHaveBeenCalled();
    });

    it('sets the user lastNotebookId when setLastNotebook is requested', async () => {
      await createSession('user-1', { name: 'My NB' }, allowAbility, { setLastNotebook: true });
      expect(UserMock.updateOne).toHaveBeenCalledWith({ _id: 'user-1' }, { lastNotebookId: 'new-session-id' });
    });
  });

  describe('getFavoriteSessionByUser', () => {
    beforeEach(() => {
      favoriteRepoFind.mockResolvedValue([{ documentId: 'fav-session-1' }]);
      userRepoFindById.mockResolvedValue({ id: 'user-1' });
      defineAbilitiesForSpy.mockReturnValue(allowAbility);
      SessionModelMock.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    });

    it('re-checks the callers current access instead of trusting the stored favorite row', async () => {
      await getFavoriteSessionByUser('user-1');

      expect(userRepoFindById).toHaveBeenCalledWith('user-1');
      expect(defineAbilitiesForSpy).toHaveBeenCalledWith({ id: 'user-1' });
      expect(accessibleBySpy).toHaveBeenCalledWith(allowAbility, 'read');

      const query = SessionModelMock.find.mock.calls[0][0];
      expect(query.$and).toEqual(expect.arrayContaining([{}, { _id: { $in: ['fav-session-1'] } }]));
    });
  });
});
