import { IAuthSessionDevice } from '@bike4mind/common';
import { getClientIp, type ClientIpRequest } from '@server/utils/ip';

type SessionDeviceRequest = ClientIpRequest & {
  headers: Record<string, string | string[] | undefined>;
};

/**
 * Capture lightweight device metadata for an AuthSession from the request, for the active-sessions
 * UI. Best-effort: absent headers just yield undefined fields. Richer client-reported details
 * (browser/OS) can be layered on later; the raw user-agent + IP are enough to identify a device.
 */
export function buildSessionDevice(req: SessionDeviceRequest): IAuthSessionDevice {
  const ua = req.headers['user-agent'];
  const ip = getClientIp(req);
  return {
    userAgent: Array.isArray(ua) ? ua[0] : ua,
    ip: ip === 'unknown' ? undefined : ip,
  };
}
