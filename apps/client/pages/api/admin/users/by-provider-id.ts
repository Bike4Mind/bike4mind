import { ApiKeyScope } from '@bike4mind/common';
import { User, platformEndUserRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { z } from 'zod';

type AccountRow = { _id: unknown; name?: string; username?: string; email?: string | null };

const accountSummary = (user: AccountRow) => ({
  id: String(user._id),
  name: user.name,
  username: user.username,
  email: user.email ?? null,
});

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
 * The value is toProviderEndUserId(user id), stored on the User model as `providerEndUserId`
 * (`kind: 'user'`), or, failing that, toPlatformEndUserProviderId for an end user a platform key named
 * with `end_user_id` (`kind: 'platformEndUser'`, with the key owner as `account`).
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
      if (user) return res.json({ kind: 'user', ...accountSummary(user) });

      const endUser = await platformEndUserRepository.findByProviderEndUserId(parsed.data.id);
      if (!endUser) throw new NotFoundError('No account has this provider end-user identifier');
      const owner = await User.findById(endUser.keyOwnerId).select('_id name username email').lean();
      return res.json({
        kind: 'platformEndUser',
        account: owner ? accountSummary(owner) : null,
        endUserId: endUser.endUserId,
        apiKeyId: endUser.apiKeyId ?? null,
        firstSeenAt: endUser.firstSeenAt,
        lastSeenAt: endUser.lastSeenAt,
      });
    })
  );

export default handler;
