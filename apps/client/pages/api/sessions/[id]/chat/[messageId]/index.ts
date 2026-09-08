import { questRepository, sessionRepository } from '@bike4mind/database';
import { sessionService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { IChatHistoryItem, redactPromptMetaForViewer } from '@bike4mind/common';

const handler = baseApi()
  /**
   * Get a chat message from a session
   */
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string; messageId?: string }>(async (req, res) => {
      const { id: sessionId, messageId } = req.query;
      const userId = req.user?.id;

      const session = await sessionRepository.findById(sessionId!);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const userHasAccess = session.userId === userId || session.users?.some(userShare => userShare.userId === userId);

      if (!userHasAccess) {
        return res.status(403).json({ error: 'Not authorized to access this session' });
      }

      // Bound to sessionId, not a bare findById(messageId) - the userHasAccess check above only
      // proves the caller belongs to the session named in the URL, not that messageId is one of
      // ITS quests. A bare findById would let a caller who owns ANY session pass isOwner for a
      // quest belonging to someone else's session entirely, handing back that owner's promptMeta.
      const message = await questRepository.findBySessionIdAndId(sessionId!, messageId!);
      if (!message) {
        return res.status(404).json({ error: 'Message not found' });
      }

      // A share grant authorizes reading the conversation, not re-reading whatever the
      // owner's tools touched on the owner's behalf - see redactPromptMetaForViewer.
      const isOwner = session.userId === userId;
      return res.json({ ...message, promptMeta: redactPromptMetaForViewer(message.promptMeta, isOwner) });
    })
  )
  /**
   * Delete a chat message from a session
   */
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string; messageId?: string }>(async (req, res) => {
      const { id: sessionId, messageId } = req.query;

      const userId = req.user?.id;
      await sessionService.deleteSessionMessage(
        userId,
        { sessionId: sessionId!, messageId: messageId! },
        {
          db: {
            sessions: sessionRepository,
            chatHistories: questRepository,
          },
        }
      );
      return res.json({ msg: 'Session deleted' });
    })
  )
  /**
   * Update a chat message in a session
   */
  .put(
    asyncHandler<{}, any, any, { id?: string; messageId?: string }>(async (req, res) => {
      const { id: sessionId, messageId } = req.query;
      const updates = req.body as { reply?: string; replies?: string[] };
      const userId = req.user?.id;

      const session = await sessionRepository.findById(sessionId!);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const userHasAccess = session.userId === userId || session.users?.some(userShare => userShare.userId === userId);

      if (!userHasAccess) {
        return res.status(403).json({ error: 'Not authorized to update this session' });
      }

      // See the GET handler's comment: bound to sessionId, not a bare findById(messageId).
      const message = await questRepository.findBySessionIdAndId(sessionId!, messageId!);
      if (!message) {
        return res.status(404).json({ error: 'Message not found' });
      }

      // Allowlist fields to update so callers can't set arbitrary document properties
      const allowedUpdates: Partial<IChatHistoryItem> = {};

      if (typeof updates.reply === 'string') {
        allowedUpdates.reply = updates.reply;
      }

      if (Array.isArray(updates.replies) && updates.replies.every(item => typeof item === 'string')) {
        allowedUpdates.replies = updates.replies;
      }

      const updatedMessage = await questRepository.update({
        ...message,
        ...allowedUpdates,
      });

      // Only reachable if the quest was deleted between the findBySessionIdAndId check above and
      // this update (or update() encounters some other unmatched-document case) - report it as a
      // real failure rather than a 200 whose data.promptMeta is silently undefined.
      if (!updatedMessage) {
        return res.status(404).json({ error: 'Message not found' });
      }

      // A share grant authorizes reading the conversation, not re-reading whatever the
      // owner's tools touched on the owner's behalf - see redactPromptMetaForViewer.
      // (updatedMessage is already a plain object here - BaseRepository.update calls
      // .toJSON() internally before returning.)
      const isOwner = session.userId === userId;
      return res.json({
        success: true,
        message: 'Message updated successfully',
        data: { ...updatedMessage, promptMeta: redactPromptMetaForViewer(updatedMessage.promptMeta, isOwner) },
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
