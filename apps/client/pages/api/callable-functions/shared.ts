import { UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { resolveCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import { listSharedCallableFunctions } from '@bike4mind/server-utils/callableFunctions/sharing';

// Session-only (`jwtOnly`), like the rest of pages/api/callable-functions: no code or artifact in the answer.
const handler = baseApi({ auth: 'jwtOnly' }).get(
  perUserRateLimit('GET /api/callable-functions/shared'),
  async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    if (!(await resolveCallableFunctionsEnabled(req.user))) return res.json([]);
    res.json(await listSharedCallableFunctions(req.user));
  }
);

export default handler;
