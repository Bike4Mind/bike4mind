import type { Request, Response, NextFunction } from 'express';
import type { IUserDocument } from '@bike4mind/common';
import { needsActivityStamp, recordUserActivity } from '@server/users/recordUserActivity';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type ActivityUser = Pick<IUserDocument, 'id' | 'isSystem' | 'deletion' | 'lastActiveAt'> & {
  impersonatedBy?: string;
  mfaPending?: boolean;
};

/**
 * Stamps the signed-in user's `lastActiveAt` when a request does work: any write method, from a
 * session, an API key or an OAuth grant. Reads never stamp, and routes the app calls on its own
 * (telemetry, socket tickets) opt out through baseApi's `recordsActivity: false`. Runs after
 * `auth`, which loads req.user fresh, so a recent stamp skips the write without a round trip.
 * Impersonated and MFA-pending sessions are not the user acting, so they never stamp.
 */
export function userActivityMiddleware() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = req.user as ActivityUser | undefined;
    if (
      user &&
      !SAFE_METHODS.has((req.method ?? 'GET').toUpperCase()) &&
      user.isSystem !== true &&
      !user.deletion &&
      !user.impersonatedBy &&
      !user.mfaPending &&
      needsActivityStamp(user.lastActiveAt, new Date())
    ) {
      recordUserActivity(user.id, req.logger);
    }
    next();
  };
}
