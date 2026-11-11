import { ApiKeyScope } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
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
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-users-by-provider-id' }))
  .get(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          message: 'Invalid query parameters',
          error: parsed.error.issues[0]?.message ?? 'Invalid query parameters',
        });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      const user = await User.findOne({ providerEndUserId: parsed.data.id }).select('_id name username email').lean();
      if (!user) throw new NotFoundError('No account has this provider end-user identifier');
      return res.json({ id: String(user._id), name: user.name, username: user.username, email: user.email ?? null });
    })
  );

export default handler;
