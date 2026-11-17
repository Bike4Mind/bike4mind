import { ApiKeyScope } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { z } from 'zod';

const QuerySchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/i, 'id must be a 64-character hex provider end-user identifier')
    .transform(id => id.toLowerCase()),
});

/**
 * GET /api/admin/users/by-provider-id?id=<64 hex>: the account behind the end-user identifier an LLM
 * provider names in a safety notice (OpenAI `safety_identifier`, Anthropic `metadata.user_id`).
 * The value is toProviderEndUserId(user id), stored on the User model as `providerEndUserId`.
 * `support:read` is what already opens a user's profile, so a support delegate can resolve a notice too.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'support:read' },
})
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-users-by-provider-id' }))
  .get(
    asyncHandler(async (req, res) => {
      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          message: 'Invalid query parameters',
          error: parsed.error.issues[0]?.message ?? 'Invalid query parameters',
        });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      const user = await User.findOne({ providerEndUserId: parsed.data.id }).select('_id name username email').lean();
      await recordAdminActionFromRequest(req, {
        action: 'user.provider_id.resolved',
        target: user
          ? { kind: 'user', id: String(user._id), displayName: user.email ?? user.username }
          : { kind: 'system', id: 'provider-end-user-id', displayName: 'Provider end-user identifier' },
        summary: user
          ? 'Resolved a provider end-user identifier to an account'
          : 'Looked up an unknown provider end-user identifier',
        details: { providerEndUserId: parsed.data.id, matched: Boolean(user), source: 'by_provider_id' },
      });
      if (!user) throw new NotFoundError('No account has this provider end-user identifier');
      return res.json({ id: String(user._id), name: user.name, username: user.username, email: user.email ?? null });
    })
  );

export default handler;
