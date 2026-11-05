import {
  ApiKeyScope,
  BadRequestError,
  ForbiddenError,
  MAX_BULK_ITEMS,
  SessionEvents,
  redactSessionForClient,
  type ISessionDocument,
} from '@bike4mind/common';
import { assertApiKeyScope } from '@bike4mind/server-utils/middlewares/apiKeyScopeGate';
import { buildSessionUpdateAdapters } from '@server/sessions/sessionUpdateAdapters';
import { queueSessionTags } from '@server/sessions/queueSessionTags';
import type { Request } from 'express';
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
const MAX_TAGS_PER_REQUEST = 20;
const MAX_TAG_LENGTH = 100;

const FavoriteBodySchema = z.object({ action: z.literal('favorite'), add: SessionIdsSchema, remove: SessionIdsSchema });
const AddTagsBodySchema = z.object({
  action: z.literal('addTags'),
  sessionIds: SessionIdsSchema.min(1, 'Provide at least one session id'),
  tags: z.array(z.string().trim().min(1, 'Tags cannot be empty').max(MAX_TAG_LENGTH)).min(1).max(MAX_TAGS_PER_REQUEST),
});
const GenerateTagsBodySchema = z.object({
  action: z.literal('generateTags'),
  sessionIds: SessionIdsSchema.min(1, 'Provide at least one session id'),
});

const BulkWriteBodySchema = z
  .discriminatedUnion('action', [FavoriteBodySchema, AddTagsBodySchema, GenerateTagsBodySchema])
  .superRefine((b, ctx) => {
    if (b.action !== 'favorite') return;
    if (b.add.length + b.remove.length === 0)
      ctx.addIssue({ code: 'custom', message: 'Provide at least one session id' });
    if (new Set([...b.add, ...b.remove]).size > MAX_BULK_ITEMS) {
      ctx.addIssue({ code: 'custom', message: `At most ${MAX_BULK_ITEMS} session ids` });
    }
    if (b.add.some(id => b.remove.includes(id))) {
      ctx.addIssue({ code: 'custom', message: 'A session id cannot be both added and removed' });
    }
  });

type BulkItemResult = { id: string; ok: boolean; error?: string; session?: unknown };
type BulkWriteResponse = { results: BulkItemResult[]; okCount: number };
type BulkWriteRequest = Request<{}, BulkWriteResponse, unknown, unknown, Record<string, unknown>>;

// Same scope PUT /api/sessions/[id] requires; checked per action because the route-level gate
// would also apply to the scope-less bulk DELETE.
const assertCanWriteNotebooks = (req: BulkWriteRequest) =>
  assertApiKeyScope(req, [ApiKeyScope.WRITE_NOTEBOOKS], 'Insufficient API key permissions');

async function addTags(req: BulkWriteRequest, sessionIds: string[], tags: string[]): Promise<BulkWriteResponse> {
  assertCanWriteNotebooks(req);
  const user = req.user!;
  const ids = [...new Set(sessionIds)];
  const newTags = [...new Set(tags.map(t => t.trim()))];
  const adapters = buildSessionUpdateAdapters(req, user, req.logger);
  const results: BulkItemResult[] = [];

  for (const id of ids) {
    if (!isValidObjectId(id)) {
      results.push({ id, ok: false, error: 'Invalid session id' });
      continue;
    }
    let updated: Awaited<ReturnType<typeof sessionService.updateSession>>;
    try {
      // Read and merge inside the retryable transaction so concurrent tag writes are preserved.
      updated = await withTransaction(async () => {
        const session = await plainSessionRepository.shareable.findUpdateAccessById(user, id);
        if (!session) throw new Error('Cannot update session');
        const existing = session.tags ?? [];
        const merged = [
          ...existing,
          ...newTags.filter(name => !existing.some(tag => tag.name === name)).map(name => ({ name, strength: 1 })),
        ];
        return sessionService.updateSession(user, { id, tags: merged }, adapters);
      });
    } catch (error) {
      req.logger.warn('[sessions/bulk] tag update failed', { sessionId: id, error });
      results.push({ id, ok: false, error: 'Update failed' });
      continue;
    }
    results.push({ id, ok: true, session: redactSessionForClient(updated as ISessionDocument) });
    // The write already landed; an analytics failure must not report the item as failed.
    try {
      await logEvent(
        {
          userId: user.id,
          type: SessionEvents.UPDATE_SESSION,
          metadata: {
            sessionId: id,
            sessionName: updated.name,
            knowledgeIds: updated.knowledgeIds ?? [],
            agentIds: updated.agentIds ?? [],
          },
        },
        { ability: req.ability }
      );
    } catch (error) {
      req.logger.warn('[sessions/bulk] tag update event log failed', { sessionId: id, error });
    }
  }
  return { results, okCount: results.filter(r => r.ok).length };
}

async function generateTags(req: BulkWriteRequest, sessionIds: string[]): Promise<BulkWriteResponse> {
  assertCanWriteNotebooks(req);
  // impersonationGate admits POST here for favorite/addTags; AI tagging stays off-limits, as on /[id]/tag.
  if (req.user?.impersonatedBy) throw new ForbiddenError('Not available while impersonating');
  const ids = [...new Set(sessionIds)];
  const { queued, failed } = await queueSessionTags(req, ids);
  const queuedIds = new Set(queued.map(q => q.sessionId));
  const failedIds = new Set(failed);
  const results: BulkItemResult[] = ids.map(id => {
    if (queuedIds.has(id)) return { id, ok: true };
    return { id, ok: false, error: failedIds.has(id) ? 'Could not queue tagging' : 'Cannot update session' };
  });
  return { results, okCount: queued.length };
}

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
      if (body.action === 'addTags') return res.json(await addTags(req, body.sessionIds, body.tags));
      if (body.action === 'generateTags') return res.json(await generateTags(req, body.sessionIds));
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
