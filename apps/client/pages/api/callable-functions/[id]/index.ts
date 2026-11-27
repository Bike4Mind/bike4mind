import { UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import {
  deleteCallableFunction,
  getCallableFunction,
  updateCallableFunctionSettings,
} from '@bike4mind/server-utils/callableFunctions/registry';
import {
  callableFunctionPatchBodySchema,
  parseCallableFunctionBody,
} from '@server/validators/callableFunctionValidators';

const functionId = (query: { id?: string | string[] }): string => (typeof query.id === 'string' ? query.id : '');

const handler = baseApi({ auth: 'jwtOnly' })
  .get(perUserRateLimit('GET /api/callable-functions/[id]'), async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    res.json(await getCallableFunction(req.user, functionId(req.query)));
  })
  .patch(perUserRateLimit('PATCH /api/callable-functions/[id]'), async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    const body = parseCallableFunctionBody(callableFunctionPatchBodySchema, req.body);
    res.json(await updateCallableFunctionSettings(req.user, functionId(req.query), body));
  })
  // Not gated, as for custom connections: a person can always remove what they saved.
  .delete(perUserRateLimit('DELETE /api/callable-functions/[id]'), async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await deleteCallableFunction(req.user, functionId(req.query));
    res.status(204).end();
  });

export default handler;
