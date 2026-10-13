import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { passkeyCredentialRepository } from '@bike4mind/database';
import { toPasskeySummary } from '@server/auth/passkey';

/** The caller's enrolled passkeys. Always scoped to req.user.id. */
const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler(async (req, res) => {
    const passkeys = await passkeyCredentialRepository.listByUser(req.user.id);
    return res.json({ passkeys: passkeys.map(toPasskeySummary) });
  })
);

export default handler;
