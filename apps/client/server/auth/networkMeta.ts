import type { INetworkMeta } from '@bike4mind/common';
import { authEventRepository, User } from '@bike4mind/database';
import { getClientIp, getClientNetwork, type ClientIpRequest } from '@bike4mind/server-utils/utils/ip';
import { DATACENTER_ASNS } from './datacenterAsns';

export type NetworkRequest = ClientIpRequest & {
  headers: Record<string, string | string[] | undefined>;
};

/**
 * The network a request came from. ASN and country come from CloudFront's viewer headers only;
 * when the distribution does not forward them every derived field is null, never a guess.
 */
export function readNetworkMeta(req: NetworkRequest): INetworkMeta {
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'];
  const { asn, country } = getClientNetwork(req);
  return {
    ip: ip === 'unknown' ? null : ip,
    userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) || null,
    asn,
    asnOrg: asn === null ? null : (DATACENTER_ASNS.get(asn) ?? null),
    country,
    isDatacenter: asn === null ? null : DATACENTER_ASNS.has(asn),
  };
}

// console.warn, as recordSignupAcquisition does: a log call that could itself throw would break
// the never-throw contract below.
function warnNotRecorded(what: string, err: unknown): void {
  console.warn(`[auth] ${what} not recorded`, err instanceof Error ? err.message : err);
}

/**
 * Stamp the signup's network on the new user (once: a retried handler keeps the first capture) and
 * log a signup AuthEvent. Each write fails on its own. Never throws: losing this metadata must not
 * fail an account creation.
 */
export async function recordSignupNetwork(opts: {
  req: NetworkRequest;
  userId: string;
  method: string;
}): Promise<void> {
  const meta = readNetworkMeta(opts.req);
  try {
    await User.updateOne(
      { _id: opts.userId, signupMeta: null },
      { $set: { signupMeta: { ...meta, capturedAt: new Date() } } }
    );
  } catch (err) {
    warnNotRecorded('signup network metadata', err);
  }
  try {
    await authEventRepository.record({ ...meta, userId: opts.userId, type: 'signup', method: opts.method });
  } catch (err) {
    warnNotRecorded('signup event', err);
  }
}

/** Log a login AuthEvent. Never throws: a lost row must not fail the sign-in. */
export async function recordLoginEvent(opts: { req: NetworkRequest; userId: string; method: string }): Promise<void> {
  try {
    await authEventRepository.record({
      ...readNetworkMeta(opts.req),
      userId: opts.userId,
      type: 'login',
      method: opts.method,
    });
  } catch (err) {
    warnNotRecorded('login event', err);
  }
}
