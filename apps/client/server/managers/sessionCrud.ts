import { Ability } from '@server/auth/ability';
import { accessibleBy } from '@casl/mongoose';
import {
  compareMongoIds,
  favoriteRepository,
  mongoose,
  Session,
  fabFileRepository,
  projectRepository,
  userRepository,
} from '@bike4mind/database';
import { NotFoundError } from '@server/utils/errors';
import { Permission, ISessionDocument, ISessionFavoriteItem, ISession, IUserDocument } from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { User, IUserObject } from '@bike4mind/database';
import { MongoQuery } from '@casl/ability';
import { Logger } from '@bike4mind/observability';
import { Session as SessionModel, sessionRepository } from '@bike4mind/database/auth';
import { sessionService, projectService } from '@bike4mind/services';
import {
  notifySessionCreated,
  logSessionCreatedEvent,
  logProjectSessionAddedEvent,
  recordNotebookAddedToProjectActivity,
} from './sessionSideEffects';

/**
 * Session lifecycle, querying, and basic persistence.
 *
 * Owns: create/get/update/delete + list/query operations. Delegates observable
 * side effects (WebSocket notifications, analytics, activity logging) to
 * `sessionSideEffects` via composition.
 */

export const generateNewSession = (userId: string, name: string): Omit<ISession, 'id'> => {
  return {
    name,
    userId,
    lastUpdated: new Date(),
    firstCreated: new Date(),
    knowledgeIds: [],
  };
};

export const getDefaultSession = (userId: string): Omit<ISession, 'id'> => {
  return generateNewSession(userId, 'New Notebook');
};

export interface GetOrCreateSessionParams {
  /** Existing session ID (if provided, will fetch instead of create) */
  sessionId?: string;
  /** Session name for new sessions */
  sessionName?: string;
  /** Project ID if session should be associated with a project */
  projectId?: string;
  /** User object */
  user: IUserDocument;
  /** User's CASL ability for authorization */
  ability?: Ability;
  /** Logger instance */
  logger: Logger;
  /** Fab file IDs if session should be associated with fab files */
  fabFileIds?: string[];
}

export interface GetOrCreateSessionResult {
  /** The session document (either fetched or newly created) */
  session: ISessionDocument;
  /** Session ID for convenience */
  sessionId: string;
  /** Whether a new session was created (true) or existing one fetched (false) */
  wasCreated: boolean;
  /** Array of async promises for logging and activities (caller should handle these) */
  asyncPromises: Promise<unknown>[];
}

/**
 * Gets an existing session or creates a new one with all associated logging and activities.
 * This consolidates the session creation logic that was repeated across multiple API endpoints.
 *
 * @param params - Parameters for session creation/retrieval
 * @returns Session document, creation flag, and async promises for logging
 *
 * @example
 * ```ts
 * const { session, sessionId, wasCreated, asyncPromises } = await getOrCreateSession({
 *   sessionId: req.body.sessionId,
 *   sessionName: req.body.sessionName,
 *   projectId: req.body.projectId,
 *   user: req.user,
 *   ability: req.ability,
 *   logger: req.logger,
 * });
 *
 * // Handle async promises in background (non-blocking)
 * Promise.all(asyncPromises).catch(err => logger.error('Background task failed:', err));
 * ```
 */
export async function getOrCreateSession(params: GetOrCreateSessionParams): Promise<GetOrCreateSessionResult> {
  const { sessionId: reqSessionId, sessionName, projectId, user, ability, logger, fabFileIds } = params;
  const userId = user.id;

  const asyncPromises: Promise<unknown>[] = [];
  let session: ISessionDocument | null;
  let wasCreated = false;

  if (reqSessionId) {
    session = await sessionRepository.findById(reqSessionId);
  } else {
    const createdSession = await sessionService.createSession(
      user,
      {
        name: sessionName ?? 'New Notebook',
        knowledgeIds: fabFileIds ?? [],
        projectId,
      },
      {
        db: {
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: fabFileRepository,
        },
      }
    );
    // Bind into the outer `let session` and keep a narrowed const for the rest of the block -
    // TS widens `let` back to `T | null` across each await below, but a const preserves narrowing.
    session = createdSession;

    wasCreated = true;

    // Side effect: notify connected clients of the new session
    await notifySessionCreated(createdSession, userId, logger);

    // Side effect: analytics event for session creation
    asyncPromises.push(logSessionCreatedEvent(userId, createdSession, ability));

    // If created within a project, also log the ADD_SESSION event and activity
    if (projectId) {
      const project = await projectService.get(
        userId,
        { id: projectId },
        {
          db: {
            projects: projectRepository,
            users: userRepository,
          },
        }
      );

      asyncPromises.push(logProjectSessionAddedEvent(userId, projectId, project.name, createdSession.id, ability));
      asyncPromises.push(recordNotebookAddedToProjectActivity(projectId, userId));
    }

    asyncPromises.push(userRepository.update({ id: userId, lastNotebookId: createdSession.id }));
  }

  if (!session) {
    throw new NotFoundError('Session not found');
  }

  return {
    session,
    sessionId: session.id,
    wasCreated,
    asyncPromises,
  };
}

export const updateSession = async (sessionData: Partial<ISession> & { id: string }, ability: Ability) => {
  // Strip id and userId from $set - they're already in the filter via _id and accessibleBy().
  // Spreading both into an upsert causes MongoDB error 54:
  // "cannot infer query fields to set, path 'userId' is matched twice"
  const { id: _id, userId: _userId, ...updateFields } = sessionData;
  return await Session.findOneAndUpdate(
    { _id: sessionData.id, ...accessibleBy(ability, Permission.update).ofType(SessionModel) },
    { $set: { ...updateFields, lastUpdated: new Date() } },
    { upsert: true, new: true }
  );
};

export const getVisibleSessions = async (
  ability: Ability,
  search?: string,
  // filters: Record<string, unknown>,
  options?: {
    pagination?: {
      limit: number;
      page: number;
    };
    orderBy?: {
      name: string;
      direction: 'asc' | 'desc';
    };
  }
) => {
  const {
    pagination = { page: 1, limit: 10 },
    orderBy = {
      name: 'lastUpdated',
      direction: 'desc',
    },
  } = options || {};

  const q = {
    ...accessibleBy(ability, Permission.read).ofType(SessionModel),
  };

  if (search) {
    q['name'] = { $regex: escapeRegex(search), $options: 'si' };
  }

  const result = await Session.find(q)
    .skip(pagination.limit * (pagination.page - 1))
    .limit(pagination.limit + 1)
    .sort({ [orderBy.name]: orderBy.direction });

  const hasMore = result.length === pagination.limit + 1;
  if (hasMore) result.pop();

  return {
    data: result,
    hasMore,
  };
};

export const getSessionsByUser = async (
  user: IUserObject,
  search?: string,
  // filters: Record<string, unknown>,
  options?: {
    pagination?: {
      limit: number;
      page: number;
    };
    orderBy?: {
      name: string;
      direction: 'asc' | 'desc';
    };
  }
) => {
  const q: MongoQuery = {
    userId: user.id,
  };

  if (search) {
    q['name'] = { $regex: escapeRegex(search), $options: 'si' };
  }

  return paginatedSessions(q, options);
};

export const getFavoriteSessionByUser = async (userId: string): Promise<ISessionFavoriteItem[]> => {
  const sessionFavorites = await favoriteRepository.find({ userId, documentType: 'sessions' });
  const docs = await SessionModel.find(
    {
      _id: { $in: sessionFavorites.map(favorite => favorite.documentId) },
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    },
    { _id: 1, name: 1, lastUpdated: 1, surface: 1, deletedAt: 1, userId: 1, tags: 1, users: 1 }
  ).lean();
  // lean() strips the Mongoose `id` virtual - re-derive it from _id
  return docs.map(doc => ({ ...doc, _id: String(doc._id), id: String(doc._id) })) as ISessionFavoriteItem[];
};

export const getSharedSessionsByUser = async (
  user: IUserDocument,
  search?: string,
  // filters: Record<string, unknown>,
  options?: {
    pagination?: {
      limit: number;
      page: number;
    };
    orderBy?: {
      name: string;
      direction: 'asc' | 'desc';
    };
  }
): Promise<{
  data: ISessionDocument[];
  hasMore: boolean;
}> => {
  const sessions = await sessionRepository.shareable.findAllShared(user);
  const q = Session.where({ _id: { $in: sessions.map(s => s.id) } });

  if (search) {
    q.where('name', { $regex: escapeRegex(search), $options: 'si' });
  }

  return paginatedSessions(q.getQuery(), options);
};

const paginatedSessions = async (
  query: MongoQuery,
  options?: {
    pagination?: {
      limit: number;
      page: number;
    };
    orderBy?: {
      name: string;
      direction: 'asc' | 'desc';
    };
  }
) => {
  const {
    pagination = { page: 1, limit: 10 },
    orderBy = {
      name: 'lastUpdated',
      direction: 'desc',
    },
  } = options || {};
  const result = await Session.find(query)
    .skip(pagination.limit * (pagination.page - 1))
    .limit(pagination.limit + 1)
    .sort({ [orderBy.name]: orderBy.direction });

  const hasMore = result.length === pagination.limit + 1;
  if (hasMore) result.pop();
  return {
    data: result,
    hasMore,
  };
};

export const getSessionMetadata = async (userId: string): Promise<ISessionDocument[]> => {
  return await Session.find({ userId }, 'id name lastUpdated');
};

export const getSessionById = async (sessionId: string): Promise<ISessionDocument | null> => {
  return await Session.findById(sessionId);
};

export const createSession = async (
  userId: string,
  data: Partial<ISession>,
  ability: Ability,
  options?: {
    /** If true, set the new session as the user's last notebook */
    setLastNotebook?: boolean;
    session?: mongoose.ClientSession;
  }
) => {
  if (!ability.can(Permission.create, Session)) throw new Error('Cannot create session');

  const session = options?.session ?? null;

  const defaultData: Partial<ISession> = {
    userId,
    name: data.name || 'New Notebook',
    knowledgeIds: data.knowledgeIds || [],
    lastUpdated: new Date(),
    firstCreated: new Date(),
  };

  const finalData = { ...defaultData, ...data };
  const notebook = new Session(finalData);
  await notebook.save({ session });

  if (options?.setLastNotebook) {
    await User.updateOne({ _id: userId }, { lastNotebookId: notebook.id }).session(session);
  }

  return notebook;
};

/**
 * Deletes a user session and ensures that the user always has at least one session.
 * If the session to be deleted is the user's last notebook, it updates the user's
 * `lastNotebookId` to the most recently updated session. If no other sessions exist,
 * it creates a new session for the user, and sets it as the user's last notebook.
 *
 * @returns The ID of the new last notebook, or null if no new session was created
 */
export const deleteSession = async (
  userId: string,
  sessionId: mongoose.Types.ObjectId | string,
  ability: Ability
): Promise<string | null> => {
  const userLastNotebookId = (await User.findById(userId, { lastNotebookId: 1 }))?.lastNotebookId ?? null;

  // Check if the session to be deleted is the user's current active Notebook
  const isActiveUserNotebook = userLastNotebookId ? compareMongoIds(userLastNotebookId, sessionId) : false;

  let newLastNotebookId: string | null;

  if (isActiveUserNotebook) {
    const lastSession = await Session.findOne({ userId, _id: { $ne: sessionId } }).sort({ createdAt: -1 });
    if (lastSession) {
      Logger.log('ATTACHING NEW SESSION:', lastSession.id);
      await User.findByIdAndUpdate(userId, { lastNotebookId: lastSession.id });
      newLastNotebookId = lastSession.id;
    } else {
      const newSession = await createSession(userId, getDefaultSession(userId), ability, { setLastNotebook: true });
      newLastNotebookId = newSession.id;
    }
  } else {
    // Not the user's last notebook, so lastNotebookId is unchanged
    newLastNotebookId = userLastNotebookId;
  }

  await Session.deleteOne({
    _id: sessionId,
    ...accessibleBy(ability, Permission.delete).ofType(SessionModel),
  });

  return newLastNotebookId;
};
