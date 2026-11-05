import { BadRequestError, MAX_BULK_ITEMS, SessionEvents } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { sessionService } from '@bike4mind/services';
import { sessionRepository } from '@bike4mind/database/auth';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { z } from 'zod';
import {
  favoriteRepository,
  sessionRepository as plainSessionRepository,
  projectRepository,
  fabFileRepository,
  sessionAgentConfigRepository,
  userRepository,
  organizationRepository,
  withTransaction,
} from '@bike4mind/database';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';

const SessionIdsSchema = z.array(z.string().min(1)).max(MAX_BULK_ITEMS);

const BulkWriteBodySchema = z
  .object({ action: z.literal('favorite'), add: SessionIdsSchema, remove: SessionIdsSchema })
  .refine(b => b.add.length + b.remove.length > 0, 'Provide at least one session id')
  .refine(b => new Set([...b.add, ...b.remove]).size <= MAX_BULK_ITEMS, `At most ${MAX_BULK_ITEMS} session ids`)
  .refine(b => !b.add.some(id => b.remove.includes(id)), 'A session id cannot be both added and removed');

type BulkItemResult = { id: string; ok: boolean; error?: string };
type BulkWriteResponse = { results: BulkItemResult[]; okCount: number };

const handler = baseApi()
  /**
   * Bulk delete sessions
   */
  .delete(
    asyncHandler<{}, { deletedCount: number; newLastNotebookId: string | null }, { sessionIds: string[] }>(
      async (req, res) => {
        const userId = req.user?.id;
        const { sessionIds } = req.body;

        if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
          return res.status(400).json({ deletedCount: 0, newLastNotebookId: null });
        }

        let newLastNotebook: { id: string } | null = null;
        let deletedCount = 0;

        // Delete sessions one by one to get proper newLastNotebook result
        for (const sessionId of sessionIds) {
          try {
            // Per session, not around the loop: this is best-effort bulk, so one session failing
            // must not roll back the ones already done. The transaction is what makes each
            // individual delete all-or-nothing - deleteSession rewrites grant rows on every file
            // the session touched before it tombstones anything, and a ConcurrencyConflictError
            // partway through would otherwise leave some files rewritten and some not with the
            // session still live. Same reason the single-delete route wraps it.
            const result = await withTransaction(() =>
              sessionService.deleteSession(
                userId,
                { id: sessionId },
                {
                  db: {
                    sessions: sessionRepository,
                    projects: projectRepository,
                    fabFiles: fabFileRepository,
                    users: userRepository,
                    organizations: organizationRepository,
                    sessionAgentConfigs: sessionAgentConfigRepository,
                  },
                  logger: req.logger,
                }
              )
            );

            // Keep track of the last valid notebook suggestion
            if (result) {
              newLastNotebook = result;
            }
            deletedCount++;

            await logEvent(
              { userId, type: SessionEvents.DELETE_SESSION, metadata: { sessionId } },
              { ability: req.ability }
            );
          } catch (error) {
            // Continue with other sessions even if one fails. `deletedCount` already excludes this
            // one (the increment is past the await), so the response under-reports rather than
            // claiming a delete that rolled back.
            console.error(`Failed to delete session ${sessionId}:`, error);
          }
        }

        return res.json({
          deletedCount,
          newLastNotebookId: newLastNotebook?.id || null,
        });
      }
    )
  )
  .post(
    asyncHandler<{}, BulkWriteResponse>(async (req, res) => {
      const parsed = BulkWriteBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid request body');
      }
      const body = parsed.data;
      const results: BulkItemResult[] = [];

      const favoriteAdapters = { db: { sessions: plainSessionRepository, favorites: favoriteRepository } };
      const add = [...new Set(body.add)];
      const remove = [...new Set(body.remove)];
      const operations = [
        ...add.map(id => ({
          id,
          run: () => sessionService.addFavorite(req.user, { sessionId: id }, favoriteAdapters),
        })),
        ...remove.map(id => ({
          id,
          run: () => sessionService.deleteFavorite(req.user, { sessionId: id }, favoriteAdapters),
        })),
      ];
      for (const { id, run } of operations) {
        if (!isValidObjectId(id)) {
          results.push({ id, ok: false, error: 'Invalid session id' });
          continue;
        }
        try {
          await run();
          results.push({ id, ok: true });
        } catch (error) {
          req.logger.warn('[sessions/bulk] favorite update failed', { sessionId: id, error });
          results.push({ id, ok: false, error: 'Update failed' });
        }
      }

      return res.json({ results, okCount: results.filter(r => r.ok).length });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
