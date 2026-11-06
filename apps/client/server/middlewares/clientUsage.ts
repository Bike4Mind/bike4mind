import type { Request, Response, NextFunction } from 'express';
import { User } from '@bike4mind/database';
import {
  resolveClientSurface,
  type ClientSurfaceSignal,
  type IClientUsageEntry,
  type IUserDocument,
} from '@bike4mind/common';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';

/** How stale `lastSeenAt` may get before a request refreshes it (ms). */
export const CLIENT_USAGE_STAMP_INTERVAL_MS = 24 * 60 * 60 * 1000;

type ClientUsageUser = Pick<IUserDocument, 'id' | 'isSystem' | 'deletion' | 'clientUsage'> & {
  impersonatedBy?: string;
  mfaPending?: boolean;
  oauthGrant?: unknown;
};

/** Whether this request should write: first sighting, a stale `lastSeenAt`, or a new client version. */
export function needsClientUsageStamp(
  entry: IClientUsageEntry | undefined,
  signal: ClientSurfaceSignal,
  now: Date
): boolean {
  if (!entry?.lastSeenAt) return true;
  if (signal.version && signal.version !== entry.version) return true;
  return now.getTime() - new Date(entry.lastSeenAt).getTime() >= CLIENT_USAGE_STAMP_INTERVAL_MS;
}

/**
 * Records which client (web, desktop, CLI, API) the signed-in user is calling from, on
 * `user.clientUsage.<surface>`. Runs after `auth`, which loads req.user fresh from Mongo, so the
 * stored `lastSeenAt` doubles as the throttle: at most one write per user, surface and day.
 * The write is not awaited and its update operators are idempotent, so a race only repeats it.
 * Skips impersonated and MFA-pending sessions, so neither an admin nor a half-signed-in caller
 * is attributed to the user.
 */
export function clientUsageMiddleware() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = req.user as ClientUsageUser | undefined;
    if (!user || user.isSystem === true || user.deletion || user.impersonatedBy || user.mfaPending) {
      next();
      return;
    }

    const signal = resolveClientSurface(req.headers as Record<string, string | undefined>, {
      delegatedCredential: isApiKeyAuth(req) || !!user.oauthGrant,
    });
    const now = new Date();
    if (!needsClientUsageStamp(user.clientUsage?.[signal.surface], signal, now)) {
      next();
      return;
    }

    const path = `clientUsage.${signal.surface}`;
    void User.updateOne(
      { _id: user.id },
      {
        $min: { [`${path}.firstSeenAt`]: now },
        $max: { [`${path}.lastSeenAt`]: now },
        ...(signal.version ? { $set: { [`${path}.version`]: signal.version } } : {}),
      }
    ).catch((error: unknown) => {
      req.logger?.warn('[clientUsage] failed to record client usage', { surface: signal.surface, error });
    });

    next();
  };
}
