import { getSessionByIdContract, NotFoundError } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { readSession } from '@server/sessions/readSession';
import { isObjectIdOrHexString } from 'mongoose';

export default nextRouteForContract(getSessionByIdContract).get(async (req, res) => {
  if (!isObjectIdOrHexString(req.validatedParams.id)) throw new NotFoundError('Session not found');
  return readSession(req, res);
});

export const config = { api: { externalResolver: true } };
