import { ApiKeyScope } from '@bike4mind/common';
import { User, providerEndUserMappingRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
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
 * The value is toProviderEndUserId(user id), stored on the User model as `providerEndUserId`
 * (`kind: 'user'`), or, for a platform key's own end user, the ProviderEndUserMapping row naming the
 * key owner and the `end_user_id` it sent (`kind: 'platform_end_user'`).
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
      if (user) {
        return res.json({
          kind: 'user',
          id: String(user._id),
          name: user.name,
          username: user.username,
          email: user.email ?? null,
        });
      }
      const mapping = await providerEndUserMappingRepository.findByProviderEndUserId(parsed.data.id);
      const owner = mapping
        ? await User.findOne({ _id: mapping.ownerUserId }).select('_id name username email').lean()
        : null;
      if (!mapping || !owner) throw new NotFoundError('No account has this provider end-user identifier');
      return res.json({
        kind: 'platform_end_user',
        platformAccount: {
          id: String(owner._id),
          name: owner.name,
          username: owner.username,
          email: owner.email ?? null,
        },
        endUserId: mapping.endUserId,
      });
    })
  );

export default handler;
