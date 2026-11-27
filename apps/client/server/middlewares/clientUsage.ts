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

function versionParts(version: string | undefined): number[] | null {
  const match = version ? /^\d+(?:\.\d+)*/.exec(version) : null;
  return match ? match[0].split('.').map(Number) : null;
}

/**
 * Whether `incoming` sorts above `stored` by its leading numeric `x.y.z`. Unparseable versions
 * are never newer, so they wait for the daily stamp.
 */
export function isNewerClientVersion(incoming: string, stored: string | undefined): boolean {
  const next = versionParts(incoming);
  if (!next) return false;
  const prev = versionParts(stored);
  if (!prev) return true;
  for (let i = 0; i < Math.max(next.length, prev.length); i++) {
    const diff = (next[i] ?? 0) - (prev[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * Whether this request should write: first sighting, a stale `lastSeenAt`, or an upgraded client.
 * Only an upgrade bypasses the daily throttle; two installs on different versions would otherwise
 * flip `version` back and forth and write on every request.
 */
export function needsClientUsageStamp(
  entry: IClientUsageEntry | undefined,
  signal: ClientSurfaceSignal,
  now: Date
): boolean {
  if (!entry?.lastSeenAt) return true;
  if (signal.version && isNewerClientVersion(signal.version, entry.version)) return true;
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
      },
      { timestamps: false }
    ).catch((error: unknown) => {
      req.logger?.warn('[clientUsage] failed to record client usage', { surface: signal.surface, error });
    });

    next();
  };
}
