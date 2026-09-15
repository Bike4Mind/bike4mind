import { User } from '@bike4mind/database';
import { AuthStrategy } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError } from '@server/utils/errors';
import { z } from 'zod';

const UnlinkSchema = z.object({
  strategy: z.nativeEnum(AuthStrategy),
});

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const parsed = UnlinkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError('Invalid request body');
    }
    const { strategy } = parsed.data;

    const user = await User.findById(userId);
    if (!user) {
      throw new BadRequestError('User not found');
    }

    const providers = (user.authProviders ?? []) as Array<{ strategy: string }>;
    const hasProvider = providers.some(p => p.strategy === strategy);
    if (!hasProvider) {
      // Already unlinked - idempotent success.
      req.logger.info('Unlink no-op — provider not linked', { userId, strategy });
      return res.status(200).json({ success: true });
    }

    // Intended for SSO-identity links (entries in authProviders). Not for MCP
    // integrations like GitHub, which keep a separate McpServer record + live
    // OAuth grant - those have their own disconnect handlers.
    //
    // No tokenVersion bump: unlinking a provider from an already-authenticated
    // session is a self-service action, not a credential change.
    //
    // No lockout guard needed: email OTC is always an available sign-in method
    // for passwordless users, so removing an OAuth provider can never strand
    // the account.
    await User.updateOne({ _id: userId }, { $pull: { authProviders: { strategy } } });

    req.logger.info('Unlinked auth provider', { userId, strategy });

    return res.status(200).json({ success: true });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
