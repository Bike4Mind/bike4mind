import { UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import { repinCallableFunction } from '@bike4mind/server-utils/callableFunctions/registry';
import {
  callableFunctionPinBodySchema,
  parseCallableFunctionBody,
} from '@server/validators/callableFunctionValidators';

const functionId = (query: { id?: string | string[] }): string => (typeof query.id === 'string' ? query.id : '');

const handler = baseApi({ auth: 'jwtOnly' }).post(
  perUserRateLimit('POST /api/callable-functions/[id]/pin'),
  async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    const body = parseCallableFunctionBody(callableFunctionPinBodySchema, req.body);
    res.json(await repinCallableFunction(req.user, functionId(req.query), body));
  }
);

export default handler;
