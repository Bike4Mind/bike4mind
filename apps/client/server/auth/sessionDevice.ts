import { IAuthSessionDevice } from '@bike4mind/common';

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  ip?: string;
}

/**
 * Capture lightweight device metadata for an AuthSession from the request, for the active-sessions
 * UI. Best-effort: absent headers just yield undefined fields. Richer client-reported details
 * (browser/OS) can be layered on later; the raw user-agent + IP are enough to identify a device.
 */
export function buildSessionDevice(req: RequestLike): IAuthSessionDevice {
  const ua = req.headers['user-agent'];
  const xff = req.headers['x-forwarded-for'];
  const ip = req.socket?.remoteAddress || (Array.isArray(xff) ? xff[0] : xff) || req.ip || undefined;
  return {
    userAgent: Array.isArray(ua) ? ua[0] : ua,
    ip,
  };
}
