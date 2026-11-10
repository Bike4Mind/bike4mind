import { asyncHandler } from '@server/middlewares/asyncHandler';
import { cacheRepository, userRepository, withTransaction } from '@bike4mind/database';
import { fileEmbeddingService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { BadRequestError } from '@bike4mind/utils';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

interface RequestQuery {
  userId: string;
}

/**
 * Admin-only: empty one user's file embedding window (fileEmbeddingService) so their non-lake
 * file indexing resumes before the window rolls over, without raising the limit for everyone.
 * Admin-only for the same reason as the data-lake meter reset: the window is a platform control.
 * Gated on settings:manage, the permission that already sets this window's limits (including the
 * per-user override) through /api/admin/scoped-settings: resetting the window grants no more than
 * raising that user's limit would.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'settings:manage' } })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      const { userId } = req.query as RequestQuery;
      if (typeof userId !== 'string' || !userId) {
        throw new BadRequestError('Invalid user ID');
      }
      const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

      const before = await withTransaction(async () => {
        const user = await userRepository.findById(userId);
        if (!user) {
          throw new BadRequestError('User not found');
        }

        const held = await fileEmbeddingService.resetFileEmbeddingSpendWindow(user.id, { cache: cacheRepository });
        await recordAdminActionFromRequest(req, {
          action: 'user.file_embedding_window.reset',
          target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
          summary: 'reset the file indexing window',
          reason,
          changes: [
            { field: 'fileEmbeddingWindowTokens', before: held.tokens, after: 0 },
            { field: 'fileEmbeddingWindowMicroUsd', before: held.microUsd, after: 0 },
          ],
        });
        return held;
      });

      req.logger.info(`Admin ${req.user.username} (${req.user.id}) reset the file embedding window for user ${userId}`);
      return res.json({ reset: true, before });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
