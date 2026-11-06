import { questRepository, sessionRepository } from '@bike4mind/database';
import { sessionService } from '@bike4mind/services';
import {
  canUpdateShareable,
  chatMessageResponseSchema,
  deleteSessionMessageContract,
  getSessionMessageContract,
  redactPromptMetaForViewer,
  updateChatMessageResponseSchema,
  updateSessionMessageContract,
  type IChatHistoryItem,
} from '@bike4mind/common';
import { canAccessSession } from '@bike4mind/server-utils/utils/sessionAccess';
import { ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { respond } from '@server/utils/respond';

// Reading history is not a metered action; only the per-minute burst limit applies.
const getHandler = nextRouteForContract(getSessionMessageContract, { exemptReadsFromDailyRateLimit: true }).get(
  async (req, res) => {
    const { id: requestedSessionId, messageId } = req.validatedParams;
    const userId = req.user.id;

    const session = await sessionRepository.findById(requestedSessionId);
    if (!session) throw new NotFoundError('Session not found');
    const sessionId = session.id;

    if (!canAccessSession(session, userId)) throw new ForbiddenError('Not authorized to access this session');

    // Bound to sessionId, not a bare findById(messageId): the access check above only proves the caller
    // belongs to the session in the URL, not that messageId is one of ITS quests. A bare lookup would let
    // a caller who owns ANY session read another owner's promptMeta.
    const message = await questRepository.findBySessionIdAndId(sessionId, messageId);
    if (!message) throw new NotFoundError('Message not found');

    // A share grant authorizes reading the conversation, not re-reading whatever the owner's tools
    // touched on the owner's behalf - see redactPromptMetaForViewer.
    const isOwner = session.userId === userId;
    return respond(res, chatMessageResponseSchema, {
      ...message,
      pendingAction: isOwner ? message.pendingAction : undefined,
      promptMeta: redactPromptMetaForViewer(message.promptMeta, isOwner),
    });
  }
);

const putHandler = nextRouteForContract(updateSessionMessageContract).put(async (req, res) => {
  const { id: requestedSessionId, messageId } = req.validatedParams;
  const updates = req.validated;
  const userId = req.user.id;

  const session = await sessionRepository.findById(requestedSessionId);
  if (!session) throw new NotFoundError('Session not found');
  const sessionId = session.id;

  // Update-level, not any-share: rewriting a stored reply is a write to the owner's notebook, so a
  // read-only share must not reach it. The GET above stays read-level on purpose.
  if (!canUpdateShareable(session, userId, req.user.groups ?? [])) {
    throw new ForbiddenError('Not authorized to update this session');
  }

  // See the GET handler: bound to sessionId, not a bare findById(messageId).
  const message = await questRepository.findBySessionIdAndId(sessionId, messageId);
  if (!message) throw new NotFoundError('Message not found');

  // Allowlist, so a caller cannot set arbitrary document properties.
  const allowedUpdates: Partial<IChatHistoryItem> = {};
  if (updates.reply !== undefined) allowedUpdates.reply = updates.reply;
  if (updates.replies !== undefined) allowedUpdates.replies = updates.replies;
  if (updates.pinned !== undefined) allowedUpdates.pinned = updates.pinned;

  // Only the pick is writable, never the options, and only once: the options are what the server parsed
  // from the model's reply, and the first pick is the one the conversation followed. "Once" is checked
  // against the read above, not atomically: two collaborators picking in the same instant can both pass
  // and the later write wins. Cosmetic only - the picker's own reply was already sent either way.
  const { selectedChoiceIndex } = updates;
  const storedChoices = message.suggestedChoices;
  if (
    selectedChoiceIndex !== undefined &&
    storedChoices &&
    storedChoices.selectedIndex == null &&
    selectedChoiceIndex < storedChoices.options.length
  ) {
    allowedUpdates.suggestedChoices = { ...storedChoices, selectedIndex: selectedChoiceIndex };
  }

  // Re-checked right before the write: the grant lives on the session and the write is to a quest, so
  // they cannot share one filter. A revoke landing between this read and the write still lands; closing
  // that needs a transaction, which this edit is not worth.
  const stillWritable = await sessionRepository.shareable.findUpdateAccessById(req.user, sessionId);
  if (!stillWritable) throw new ForbiddenError('Not authorized to update this session');

  const updatedMessage = await questRepository.updateInSession(sessionId, { id: message.id, ...allowedUpdates });

  // Only reachable if the quest was deleted between the read above and this write.
  if (!updatedMessage) throw new NotFoundError('Message not found');

  const isOwner = session.userId === userId;
  return respond(res, updateChatMessageResponseSchema, {
    success: true,
    message: 'Message updated successfully',
    data: {
      ...updatedMessage,
      pendingAction: isOwner ? updatedMessage.pendingAction : undefined,
      promptMeta: redactPromptMetaForViewer(updatedMessage.promptMeta, isOwner),
    },
  });
});

const deleteHandler = nextRouteForContract(deleteSessionMessageContract).delete(async (req, res) => {
  const { id: sessionId, messageId } = req.validatedParams;
  await sessionService.deleteSessionMessage(
    req.user.id,
    { sessionId, messageId },
    { db: { sessions: sessionRepository, chatHistories: questRepository } }
  );
  return res.json({ msg: 'Message deleted' });
});

export default dispatchByMethod({ GET: getHandler, PUT: putHandler, DELETE: deleteHandler });

export const config = {
  api: {
    externalResolver: true,
  },
};
