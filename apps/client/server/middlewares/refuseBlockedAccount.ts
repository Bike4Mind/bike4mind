import type { RequestHandler } from 'express';
import { accountBlockedMessage } from '@bike4mind/services/userService/accountState';
import { ForbiddenError, UnauthorizedError } from '@bike4mind/server-utils/utils/errors';

/**
 * Refuses a money-in route (credit purchase, subscription checkout or change, invoice payment, seat change) for a
 * banned, dispute-pending or suspended account. The auth layer already refuses these on every request; this keeps
 * the rule on the route itself, so it holds whatever auth mode the route is mounted with.
 */
export const refuseBlockedAccount = (): RequestHandler => (req, _res, next) => {
  if (!req.user) return next(new UnauthorizedError('User not found'));
  const message = accountBlockedMessage(req.user);
  return next(message ? new ForbiddenError(message) : undefined);
};
