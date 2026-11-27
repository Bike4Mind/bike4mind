import { UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import { summarizeCallableFunctionCalls } from '@bike4mind/server-utils/callableFunctions/registry';

const functionId = (query: { id?: string | string[] }): string => (typeof query.id === 'string' ? query.id : '');

const handler = baseApi({ auth: 'jwtOnly' }).get(
  perUserRateLimit('GET /api/callable-functions/[id]/calls'),
  async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    res.json(await summarizeCallableFunctionCalls(req.user, functionId(req.query)));
  }
);

export default handler;
