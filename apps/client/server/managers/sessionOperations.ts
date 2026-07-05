import { Ability } from '@server/auth/ability';
import { accessibleBy } from '@casl/mongoose';
import { mongoose, Quest, Session } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { NotFoundError } from '@server/utils/errors';
import { updateSharing } from '@server/managers/sharingManager';
import { IShareableDocument, Permission, ISessionDocument, IChatHistoryItem, IUserDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { Session as SessionModel, sessionRepository } from '@bike4mind/database/auth';
import { createSession } from './sessionCrud';
import { publishSummarizeSession, publishContextSummarizeSession } from './sessionSideEffects';

/**
 * Session transformation and message operations: message CRUD, fork/clone/snip,
 * generation control, sharing state, and summarization triggers.
 *
 * Depends on `sessionCrud` (for `createSession`) and `sessionSideEffects` (for event
 * publishing). The dependency direction is one-way - `sessionCrud` never imports from here.
 */

/**
 * TODO: Move this inside the b4m-core/services
 */
export const getMessagesFromSession = async (
  user: IUserDocument,
  sessionId: string | mongoose.Types.ObjectId,
  search?: string,
  options?: {
    pagination?: {
      limit: number;
      page: number;
    };
    all?: boolean;
    sort?: 'asc' | 'desc';
  }
) => {
  const session = await sessionRepository.shareable.findAccessibleById(user, sessionId.toString());

  if (!session) throw new NotFoundError('Session not found');

  const { pagination = { page: 1, limit: 10 }, all = false, sort } = options || {};
  const q: mongoose.FilterQuery<IChatHistoryItem> = {
    sessionId,
  };
  if (search) {
    const escapedSearch = escapeRegex(search);
    q['prompt'] = { $regex: escapedSearch, $options: 'si' };
    q['replies'] = { $regex: escapedSearch, $options: 'si' };
  }

  const query = Quest.find(q);

  if (!all) {
    query.skip(pagination.limit * (pagination.page - 1)).limit(pagination.limit + 1);
  }
  query.sort({ timestamp: sort || 'asc' });

  // No need for explicit select - ensure all fields are returned

  const result = await query;

  const hasMore = result.length === pagination.limit + 1;
  if (hasMore) result.pop();

  return {
    data: result,
    hasMore,
  };
};

export const addMessageToSession = async (
  // Authorization is enforced via `ability`/`accessibleBy`; the caller's userId is
  // not needed here. Kept in the signature (prefixed `_`) for call-site compatibility.
  _userId: string,
  sessionId: string | mongoose.Types.ObjectId,
  message: Omit<IChatHistoryItem, 'sessionId'>,
  ability: Ability
) => {
  const session = await Session.findOne({
    _id: sessionId,
    ...accessibleBy(ability, Permission.update).ofType(SessionModel),
  });
  if (!session) throw new NotFoundError('Session not found');

  const createdQuest = await Quest.create({ ...message, sessionId });

  const messageTimestamp = message.timestamp ?? new Date();
  const latestKnownTimestamp =
    session.lastUpdated && session.lastUpdated > messageTimestamp ? new Date() : messageTimestamp;

  await Session.updateOne(
    { _id: sessionId },
    {
      $set: {
        lastUpdated: latestKnownTimestamp,
        updatedAt: new Date(),
      },
    }
  );

  return createdQuest;
};

export const deleteMessageFromSession = async (
  // Authorization is enforced via `ability`/`accessibleBy`; the caller's userId is
  // not needed here. Kept in the signature (prefixed `_`) for call-site compatibility.
  _userId: string,
  sessionId: string,
  messageId: string,
  ability: Ability
) => {
  // This has the effect of validating permissions for the update, even as it hits Quest.deleteOne
  const session = await Session.findOne({
    _id: sessionId,
    ...accessibleBy(ability, Permission.update).ofType(SessionModel),
  });
  if (!session) throw new NotFoundError('Session not found');
  return await Quest.findOneAndUpdate({ _id: messageId, sessionId }, { $set: { deletedAt: new Date() } });
};

export const stopReply = async (sessionId: string, ability: Ability) => {
  const latestQuest = await Quest.findOne({ sessionId }).sort({ timestamp: -1 });
  const session = await Session.findOne({
    _id: sessionId,
    ...accessibleBy(ability, Permission.update).ofType(SessionModel),
  });
  if (!session) throw new NotFoundError('Session not found');
  if (!latestQuest) throw new NotFoundError('No active quest found');

  if (latestQuest.status !== 'stopped') {
    // Emit a cancellation event through pub/sub if available
    try {
      Logger.info(`Stopping quest generation for questId: ${latestQuest.id}`, {
        questId: latestQuest.id,
        sessionId,
        status: 'cancellation_requested',
      });
    } catch (error) {
      console.error('Error emitting cancellation event:', error);
    }

    return await Quest.findOneAndUpdate(
      { _id: latestQuest.id },
      {
        status: 'stopped',
        statusMessage: 'Generation cancelled by user',
      },
      { new: true } // Return the updated document
    );
  }

  return latestQuest;
};

export const updateSessionSharingState = (
  sessionId: string,
  sharingData: Partial<IShareableDocument>,
  ability: Ability
) => updateSharing(Session, sessionId, sharingData, ability);

export const forkSession = async (sessionId: string, messageId: string, ability: Ability) => {
  const session = await Session.findById(sessionId);
  if (!session) throw new NotFoundError('Session not found');

  const message = await Quest.findById(messageId);
  if (!message) throw new NotFoundError('Message not found');
  const newSession = await createSession(session.userId, { name: `Forked ${session.name}` }, ability);

  // Need to also clone the knowledge and tools, tags, and summary
  newSession.knowledgeIds = session.knowledgeIds;
  newSession.tags = session.tags;
  newSession.summary = session.summary;
  newSession.summaryAt = session.summaryAt;
  await newSession.save();

  const messagesToFork = await Quest.find({ sessionId, timestamp: { $lte: message.timestamp } });
  await Promise.all(
    messagesToFork.map(async message => {
      const { _id, id, ...messageData } = message.toObject();
      return await addMessageToSession(session.userId, newSession.id, messageData, ability);
    })
  );
  return newSession;
};

export const cloneSession = async (sessionId: string, adminUserId: string, ability: Ability) => {
  try {
    if (!ability.can('clone', Session)) {
      throw new Error('User does not have permission to clone sessions');
    }

    const session = await Session.findById(sessionId);
    if (!session) throw new NotFoundError('Session not found');

    const newSession = await createSession(
      adminUserId,
      {
        name: `Cloned ${session.name}`,
        knowledgeIds: session.knowledgeIds,
      },
      ability
    );

    newSession.tags = session.tags ? [...session.tags] : [];
    newSession.summary = session.summary;
    newSession.summaryAt = session.summaryAt;

    await newSession.save();

    const messagesToClone = await Quest.find({ sessionId });

    await Promise.all(
      messagesToClone.map(async message => {
        const { _id, id, ...messageData } = message.toObject();
        return await addMessageToSession(adminUserId, newSession.id, messageData, ability);
      })
    );

    await newSession.save();

    Logger.log(`Session ${sessionId} cloned to new session ${newSession.id} for admin ${adminUserId}`);

    return newSession;
  } catch (error) {
    Logger.error('Error cloning session:', error);
    throw error;
  }
};

export const snipSession = async (sessionId: string, messageId: string, ability: Ability) => {
  const session = await Session.findById(sessionId);
  if (!session) throw new NotFoundError('Session not found');

  const message = await Quest.findById(messageId);
  if (!message) throw new NotFoundError('Message not found');
  const newSession = await createSession(session.userId, { name: `Snipped ${session.name}` }, ability);

  // Need to also clone the knowledge and tools, tags, and summary
  newSession.knowledgeIds = session.knowledgeIds;
  newSession.tags = session.tags;
  newSession.summary = session.summary;
  newSession.summaryAt = session.summaryAt;
  await newSession.save();

  const messagesToSnip = await Quest.find({ sessionId, timestamp: { $gte: message.timestamp } });
  await Promise.all(
    messagesToSnip.map(async message => {
      const { _id, id, ...messageData } = message.toObject();
      return await addMessageToSession(session.userId, newSession.id, messageData, ability);
    })
  );
  return newSession;
};

export const summarizeSession = async (sessionId: string, trigger: ISessionDocument['summaryTrigger']) => {
  await publishSummarizeSession(sessionId, trigger);
};

export const contextSummarizeSession = async (sessionId: string, verbatimWindowStartQuestId: string) => {
  await publishContextSummarizeSession(sessionId, verbatimWindowStartQuestId);
};
