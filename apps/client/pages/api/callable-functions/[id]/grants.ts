import { UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import {
  getCallableFunctionShare,
  revokeCallableFunctionShare,
  shareCallableFunction,
} from '@bike4mind/server-utils/callableFunctions/sharing';
import {
  callableFunctionGrantsBodySchema,
  parseCallableFunctionBody,
} from '@server/validators/callableFunctionValidators';

export type { CallableFunctionShareView } from '@bike4mind/server-utils/callableFunctions/sharing';

const functionId = (query: { id?: string | string[] }): string => (typeof query.id === 'string' ? query.id : '');

// Owner only: another person's function reads as not found on every method.
const handler = baseApi({ auth: 'jwtOnly' })
  .get(perUserRateLimit('GET /api/callable-functions/[id]/grants'), async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    res.json(await getCallableFunctionShare(req.user, functionId(req.query)));
  })
  .put(perUserRateLimit('PUT /api/callable-functions/[id]/grants'), async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    const body = parseCallableFunctionBody(callableFunctionGrantsBodySchema, req.body);
    res.json(await shareCallableFunction(req.user, functionId(req.query), body));
  })
  // Not gated, as delete is not: an owner can always stop sharing.
  .delete(perUserRateLimit('DELETE /api/callable-functions/[id]/grants'), async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    res.json(await revokeCallableFunctionShare(req.user, functionId(req.query)));
  });

export default handler;
