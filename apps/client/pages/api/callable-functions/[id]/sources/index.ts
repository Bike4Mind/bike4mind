import { UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import { setCallableFunctionSources } from '@bike4mind/server-utils/callableFunctions/sources';
import {
  callableFunctionSourcesBodySchema,
  parseCallableFunctionBody,
} from '@server/validators/callableFunctionValidators';

const functionId = (query: { id?: string | string[] }): string => (typeof query.id === 'string' ? query.id : '');

const handler = baseApi({ auth: 'jwtOnly' }).put(
  perUserRateLimit('PUT /api/callable-functions/[id]/sources'),
  async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    const body = parseCallableFunctionBody(callableFunctionSourcesBodySchema, req.body);
    res.json(await setCallableFunctionSources(req.user, functionId(req.query), body.sources));
  }
);

export default handler;
